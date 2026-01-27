// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DepositRouter
 * @notice Handles deposit intents with EIP-712 signature verification
 * @dev Tracks deposit intents and forwards deposits to Lagoon vault
 */
contract DepositRouter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 private constant DEPOSIT_INTENT_TYPEHASH =
        keccak256(
            "DepositIntent(address user,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)"
        );

    struct DepositIntent {
        address user;
        address vault;
        address asset;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    struct DepositRecord {
        address user;
        address vault;
        address asset;
        uint256 amount;
        uint256 deadline;
        uint256 timestamp;
        bool executed;
        bool cancelled;
    }

    mapping(address => uint256) public nonces;
    mapping(bytes32 => DepositRecord) public deposits;

    address public immutable FEE_COLLECTOR;
    uint256 public constant FEE_BPS = 10; // 10 basis points = 0.1%

    event DepositIntentCreated(
        bytes32 indexed intentHash,
        address indexed user,
        address indexed vault,
        address asset,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    );

    event DepositExecuted(
        bytes32 indexed intentHash,
        address indexed user,
        address indexed vault,
        uint256 amount
    );

    event DepositIntentCancelled(
        bytes32 indexed intentHash,
        address indexed user
    );

    event FeeCollected(
        bytes32 indexed intentHash,
        address indexed asset,
        uint256 feeAmount
    );

    /// @dev Emitted when a deposit is requested (async/settlement vaults, e.g. 9Summits).
    /// Same flow as DepositExecuted but vault uses requestDeposit instead of syncDeposit.
    event DepositRequestSubmitted(
        bytes32 indexed intentHash,
        address indexed user,
        address indexed vault,
        uint256 amount,
        uint256 requestId
    );

    constructor(address _feeCollector) EIP712("DepositRouter", "1") {
        require(_feeCollector != address(0), "Invalid fee collector");
        FEE_COLLECTOR = _feeCollector;
    }

    /**
     * @notice Create a deposit intent with EIP-712 signature
     * @param intent The deposit intent parameters
     * @param signature The EIP-712 signature
     * @return intentHash The hash of the deposit intent
     */
    function createDepositIntent(
        DepositIntent calldata intent,
        bytes calldata signature
    ) external returns (bytes32 intentHash) {
        require(intent.user != address(0), "Invalid user address");
        require(intent.vault != address(0), "Invalid vault address");
        require(intent.asset != address(0), "Invalid asset address");
        require(intent.amount > 0, "Amount must be greater than 0");
        require(verifyIntent(intent, signature), "Invalid signature");
        require(block.timestamp <= intent.deadline, "Intent expired");
        require(intent.nonce == nonces[intent.user], "Invalid nonce");

        nonces[intent.user]++;

        intentHash = keccak256(
            abi.encode(
                DEPOSIT_INTENT_TYPEHASH,
                intent.user,
                intent.vault,
                intent.asset,
                intent.amount,
                intent.nonce,
                intent.deadline
            )
        );

        require(deposits[intentHash].user == address(0), "Intent already exists");

        deposits[intentHash] = DepositRecord({
            user: intent.user,
            vault: intent.vault,
            asset: intent.asset,
            amount: intent.amount,
            deadline: intent.deadline,
            timestamp: block.timestamp,
            executed: false,
            cancelled: false
        });

        emit DepositIntentCreated(
            intentHash,
            intent.user,
            intent.vault,
            intent.asset,
            intent.amount,
            intent.nonce,
            intent.deadline
        );

        return intentHash;
    }

    /**
     * @notice Create and execute deposit in a single transaction
     * @param intent The deposit intent parameters
     * @param signature The EIP-712 signature
     * @return intentHash The hash of the deposit intent
     */
    function depositWithIntent(
        DepositIntent calldata intent,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 intentHash) {
        require(intent.user != address(0), "Invalid user address");
        require(intent.vault != address(0), "Invalid vault address");
        require(intent.asset != address(0), "Invalid asset address");
        require(intent.amount > 0, "Amount must be greater than 0");
        require(verifyIntent(intent, signature), "Invalid signature");
        require(block.timestamp <= intent.deadline, "Intent expired");
        require(intent.nonce == nonces[intent.user], "Invalid nonce");

        nonces[intent.user]++;

        intentHash = keccak256(
            abi.encode(
                DEPOSIT_INTENT_TYPEHASH,
                intent.user,
                intent.vault,
                intent.asset,
                intent.amount,
                intent.nonce,
                intent.deadline
            )
        );

        require(deposits[intentHash].user == address(0), "Intent already exists");

        deposits[intentHash] = DepositRecord({
            user: intent.user,
            vault: intent.vault,
            asset: intent.asset,
            amount: intent.amount,
            deadline: intent.deadline,
            timestamp: block.timestamp,
            executed: true,
            cancelled: false
        });

        emit DepositIntentCreated(
            intentHash,
            intent.user,
            intent.vault,
            intent.asset,
            intent.amount,
            intent.nonce,
            intent.deadline
        );

        IERC20(intent.asset).safeTransferFrom(
            intent.user,
            address(this),
            intent.amount
        );

        uint256 feeAmount = (intent.amount * FEE_BPS) / 10000;
        uint256 depositAmount = intent.amount - feeAmount;

        if (feeAmount > 0) {
            IERC20(intent.asset).safeTransfer(FEE_COLLECTOR, feeAmount);
            emit FeeCollected(intentHash, intent.asset, feeAmount);
        }

        IERC20(intent.asset).forceApprove(intent.vault, depositAmount);

        (bool success, bytes memory returnData) = intent.vault.call(
            abi.encodeWithSignature(
                "syncDeposit(uint256,address,address)",
                depositAmount,
                intent.user,
                address(0)
            )
        );

        if (!success) {
            string memory errorMessage = "Vault deposit failed";
            
            if (returnData.length > 0) {
                if (returnData.length >= 4 && 
                    returnData[0] == 0x08 && 
                    returnData[1] == 0xc3 && 
                    returnData[2] == 0x79 && 
                    returnData[3] == 0xa0) {
                    if (returnData.length >= 68) {
                        uint256 errorLength;
                        assembly {
                            errorLength := mload(add(returnData, 0x24))
                        }
                        if (errorLength > 0 && errorLength <= returnData.length - 68) {
                            bytes memory errorBytes = new bytes(errorLength);
                            for (uint256 i = 0; i < errorLength; i++) {
                                errorBytes[i] = returnData[i + 68];
                            }
                            errorMessage = string(errorBytes);
                        }
                    }
                } else {
                    errorMessage = "Vault deposit failed: custom error";
                }
            }
            
            revert(errorMessage);
        }

        IERC20(intent.asset).forceApprove(intent.vault, 0);

        emit DepositExecuted(intentHash, intent.user, intent.vault, depositAmount);

        return intentHash;
    }

    /**
     * @notice Same as depositWithIntent but for async/settlement vaults (e.g. 9Summits).
     * Calls requestDeposit(assets, controller, owner) on the vault instead of syncDeposit.
     * Intent, signature, and fee logic are identical; only the vault call differs.
     */
    function depositWithIntentRequest(
        DepositIntent calldata intent,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 intentHash, uint256 requestId) {
        require(intent.user != address(0), "Invalid user address");
        require(intent.vault != address(0), "Invalid vault address");
        require(intent.asset != address(0), "Invalid asset address");
        require(intent.amount > 0, "Amount must be greater than 0");
        require(verifyIntent(intent, signature), "Invalid signature");
        require(block.timestamp <= intent.deadline, "Intent expired");
        require(intent.nonce == nonces[intent.user], "Invalid nonce");

        nonces[intent.user]++;

        intentHash = keccak256(
            abi.encode(
                DEPOSIT_INTENT_TYPEHASH,
                intent.user,
                intent.vault,
                intent.asset,
                intent.amount,
                intent.nonce,
                intent.deadline
            )
        );

        require(deposits[intentHash].user == address(0), "Intent already exists");

        deposits[intentHash] = DepositRecord({
            user: intent.user,
            vault: intent.vault,
            asset: intent.asset,
            amount: intent.amount,
            deadline: intent.deadline,
            timestamp: block.timestamp,
            executed: true,
            cancelled: false
        });

        emit DepositIntentCreated(
            intentHash,
            intent.user,
            intent.vault,
            intent.asset,
            intent.amount,
            intent.nonce,
            intent.deadline
        );

        IERC20(intent.asset).safeTransferFrom(
            intent.user,
            address(this),
            intent.amount
        );

        uint256 feeAmount = (intent.amount * FEE_BPS) / 10000;
        uint256 depositAmount = intent.amount - feeAmount;

        if (feeAmount > 0) {
            IERC20(intent.asset).safeTransfer(FEE_COLLECTOR, feeAmount);
            emit FeeCollected(intentHash, intent.asset, feeAmount);
        }

        IERC20(intent.asset).forceApprove(intent.vault, depositAmount);

        // Vault pulls assets from owner; we hold them. Controller owns the request (user gets shares).
        (bool success, bytes memory returnData) = intent.vault.call(
            abi.encodeWithSignature(
                "requestDeposit(uint256,address,address)",
                depositAmount,
                intent.user,
                address(this)
            )
        );

        IERC20(intent.asset).forceApprove(intent.vault, 0);

        if (!success) {
            string memory errorMessage = "Vault requestDeposit failed";
            if (returnData.length >= 4) {
                if (returnData.length >= 68 &&
                    returnData[0] == 0x08 && returnData[1] == 0xc3 &&
                    returnData[2] == 0x79 && returnData[3] == 0xa0) {
                    uint256 errLen;
                    assembly { errLen := mload(add(returnData, 0x24)) }
                    if (errLen > 0 && errLen <= returnData.length - 68) {
                        bytes memory errBytes = new bytes(errLen);
                        for (uint256 i = 0; i < errLen; i++) {
                            errBytes[i] = returnData[i + 68];
                        }
                        errorMessage = string(errBytes);
                    }
                } else {
                    errorMessage = "Vault requestDeposit failed: custom error";
                }
            }
            revert(errorMessage);
        }

        require(returnData.length >= 32, "Invalid requestDeposit return");
        requestId = abi.decode(returnData, (uint256));

        emit DepositRequestSubmitted(intentHash, intent.user, intent.vault, depositAmount, requestId);

        return (intentHash, requestId);
    }

    /**
     * @notice Execute a deposit intent by transferring assets and calling vault
     * @param intentHash The hash of the deposit intent
     */
    function executeDeposit(bytes32 intentHash) external nonReentrant {
        DepositRecord storage record = deposits[intentHash];

        require(record.user != address(0), "Intent not found");
        require(!record.executed, "Intent already executed");
        require(!record.cancelled, "Intent was cancelled");
        require(block.timestamp <= record.deadline, "Intent expired");

        record.executed = true;

        IERC20(record.asset).safeTransferFrom(
            record.user,
            address(this),
            record.amount
        );

        uint256 feeAmount = (record.amount * FEE_BPS) / 10000;
        uint256 depositAmount = record.amount - feeAmount;

        if (feeAmount > 0) {
            IERC20(record.asset).safeTransfer(FEE_COLLECTOR, feeAmount);
            emit FeeCollected(intentHash, record.asset, feeAmount);
        }

        IERC20(record.asset).forceApprove(record.vault, depositAmount);

        (bool success, bytes memory returnData) = record.vault.call(
            abi.encodeWithSignature(
                "syncDeposit(uint256,address,address)",
                depositAmount,
                record.user,
                address(0)
            )
        );

        if (!success) {
            string memory errorMessage = "Vault deposit failed";
            
            if (returnData.length > 0) {
                if (returnData.length >= 4 && 
                    returnData[0] == 0x08 && 
                    returnData[1] == 0xc3 && 
                    returnData[2] == 0x79 && 
                    returnData[3] == 0xa0) {
                    if (returnData.length >= 68) {
                        uint256 errorLength;
                        assembly {
                            errorLength := mload(add(returnData, 0x24))
                        }
                        if (errorLength > 0 && errorLength <= returnData.length - 68) {
                            bytes memory errorBytes = new bytes(errorLength);
                            for (uint256 i = 0; i < errorLength; i++) {
                                errorBytes[i] = returnData[i + 68];
                            }
                            errorMessage = string(errorBytes);
                        }
                    }
                } else {
                    errorMessage = "Vault deposit failed: custom error";
                }
            }
            
            revert(errorMessage);
        }

        IERC20(record.asset).forceApprove(record.vault, 0);

        emit DepositExecuted(intentHash, record.user, record.vault, depositAmount);
    }

    /**
     * @notice Cancel a deposit intent (only the user can cancel their own intent)
     * @param intentHash The hash of the deposit intent to cancel
     */
    function cancelIntent(bytes32 intentHash) external {
        DepositRecord storage record = deposits[intentHash];

        require(record.user != address(0), "Intent not found");
        require(record.user == msg.sender, "Only user can cancel");
        require(!record.executed, "Intent already executed");
        require(!record.cancelled, "Intent already cancelled");

        record.cancelled = true;

        emit DepositIntentCancelled(intentHash, msg.sender);
    }

    /**
     * @notice Verify EIP-712 signature
     * @param intent The deposit intent
     * @param signature The signature to verify
     * @return true if signature is valid
     */
    function verifyIntent(
        DepositIntent calldata intent,
        bytes calldata signature
    ) public view returns (bool) {
        bytes32 structHash = keccak256(
            abi.encode(
                DEPOSIT_INTENT_TYPEHASH,
                intent.user,
                intent.vault,
                intent.asset,
                intent.amount,
                intent.nonce,
                intent.deadline
            )
        );

        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, signature);

        return signer == intent.user;
    }

    /**
     * @notice Get the current nonce for a user
     * @param user The user address
     * @return The current nonce
     */
    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    /**
     * @notice Get deposit record by intent hash
     * @param intentHash The intent hash
     * @return The deposit record
     */
    function getDeposit(bytes32 intentHash)
        external
        view
        returns (DepositRecord memory)
    {
        return deposits[intentHash];
    }

    /**
     * @notice Check if an intent is still valid (not executed, not cancelled, not expired)
     * @param intentHash The intent hash
     * @return True if intent can still be executed
     */
    function isIntentValid(bytes32 intentHash) external view returns (bool) {
        DepositRecord storage record = deposits[intentHash];
        return (
            record.user != address(0) &&
            !record.executed &&
            !record.cancelled &&
            block.timestamp <= record.deadline
        );
    }

    /**
     * @notice Get the EIP-712 domain separator
     * @return The domain separator hash
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
