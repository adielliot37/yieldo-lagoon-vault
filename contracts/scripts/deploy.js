const hre = require("hardhat");

async function main() {
  console.log("Deploying DepositRouter...");
  console.log("Network:", hre.network.name);
  
  const rpcUrl = hre.network.name === 'mainnet' 
    ? (process.env.ETHEREUM_RPC_URL || "https://rpc.fullsend.to")
    : (process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc");
  console.log("RPC URL:", rpcUrl);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  try {
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const nativeToken = hre.network.name === 'mainnet' ? 'ETH' : 'AVAX';
    console.log("Account balance:", hre.ethers.formatEther(balance), nativeToken);
    
    if (balance === 0n) {
      console.error(`❌ ERROR: Account has no ${nativeToken}. Please fund your account first.`);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ ERROR: Could not check balance. RPC might be down:", error.message);
    process.exit(1);
  }

  console.log("\nCreating contract factory...");
  const DepositRouter = await hre.ethers.getContractFactory("DepositRouter");
  const FEE_COLLECTOR = process.env.FEE_COLLECTOR || "0xBEb2986BD5b7ADDB360D0BbdAD9a7DE21854F427";
  console.log("Fee Collector:", FEE_COLLECTOR);
  console.log("Deploying contract (this may take 1-2 minutes)...");
  console.log("⏳ Sending deployment transaction...");
  
  let depositRouter;
  try {
    depositRouter = await DepositRouter.deploy(FEE_COLLECTOR);
    const tx = depositRouter.deploymentTransaction();
    
    if (tx) {
      console.log("✅ Transaction sent! Hash:", tx.hash);
      console.log("⏳ Waiting for confirmation (this may take 30-60 seconds)...");
      const explorerUrl = hre.network.name === 'mainnet'
        ? `https://etherscan.io/tx/${tx.hash}`
        : `https://snowtrace.io/tx/${tx.hash}`;
      console.log("   View on explorer:", explorerUrl);
    } else {
      console.log("⏳ Waiting for deployment...");
    }

    await depositRouter.waitForDeployment();
    console.log("✅ Deployment confirmed!");
  } catch (error) {
    console.error("❌ Deployment failed:", error.message);
    const nativeToken = hre.network.name === 'mainnet' ? 'ETH' : 'AVAX';
    if (error.message.includes("insufficient funds")) {
      console.error(`   Your account doesn't have enough ${nativeToken} for gas fees.`);
    } else if (error.message.includes("network")) {
      console.error("   Network error. Check your RPC URL and internet connection.");
    }
    throw error;
  }

  const address = await depositRouter.getAddress();
  console.log("DepositRouter deployed to:", address);

  const deploymentInfo = {
    network: hre.network.name,
    contract: "DepositRouter",
    address: address,
    deployer: (await hre.ethers.getSigners())[0].address,
    timestamp: new Date().toISOString(),
  };

  console.log("\nDeployment Info:");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  const explorerUrl = hre.network.name === 'mainnet'
    ? `https://etherscan.io/address/${address}`
    : `https://snowtrace.io/address/${address}`;
  const verifyNetwork = hre.network.name;
  
  console.log("\n📝 Next steps:");
  console.log(`1. Update DEPOSIT_ROUTER_ADDRESS in indexer/.env and frontend/.env.local`);
  console.log(`2. Verify contract: npx hardhat run scripts/verify.js --network ${verifyNetwork} ${address}`);
  console.log(`3. View on explorer: ${explorerUrl}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

