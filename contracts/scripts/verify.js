const hre = require("hardhat");

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  
  if (!contractAddress || !contractAddress.startsWith('0x')) {
    console.error("❌ Contract address required!");
    console.error("\nUsage:");
    console.error("  CONTRACT_ADDRESS=0x99833702EE87DC29F294E98D2f7561247F02A5cA npx hardhat run scripts/verify.js --network mainnet");
    console.error("\nOr set it in your .env file:");
    console.error("  CONTRACT_ADDRESS=0x99833702EE87DC29F294E98D2f7561247F02A5cA");
    process.exit(1);
  }

  const FEE_COLLECTOR = process.env.FEE_COLLECTOR || "0xBEb2986BD5b7ADDB360D0BbdAD9a7DE21854F427";
  
  const network = hre.network.name;
  const explorerName = network === 'mainnet' ? 'Etherscan' : 'Snowtrace';
  const explorerUrl = network === 'mainnet' 
    ? `https://etherscan.io/address/${contractAddress}#code`
    : `https://snowtrace.io/address/${contractAddress}#code`;

  console.log(`Verifying contract at ${contractAddress} on ${explorerName}...`);
  console.log(`Network: ${network}`);
  console.log(`Fee Collector: ${FEE_COLLECTOR}`);

  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: [FEE_COLLECTOR],
    });
    
    console.log(`✅ Contract verified successfully!`);
    console.log(`View on ${explorerName}: ${explorerUrl}`);
  } catch (error) {
    if (error.message.includes("Already Verified") || error.message.includes("already verified")) {
      console.log("✅ Contract is already verified!");
      console.log(`View on ${explorerName}: ${explorerUrl}`);
    } else {
      console.error("❌ Verification failed:", error.message);
      console.error("\nMake sure:");
      console.error("  1. The contract address is correct");
      console.error(`  2. FEE_COLLECTOR matches the one used in deployment: ${FEE_COLLECTOR}`);
      console.error("  3. The network is correct");
      process.exit(1);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

