const hre = require("hardhat");

async function main() {
  // Get address from environment variable or command line
  // Usage: CONTRACT_ADDRESS=0x... npx hardhat run scripts/verify.js --network avalanche
  // Or: npx hardhat run scripts/verify.js --network avalanche --address 0x...
  const contractAddress = process.env.CONTRACT_ADDRESS || 
                          process.argv.find(arg => arg.startsWith('--address'))?.split('=')[1] ||
                          process.argv[process.argv.length - 1];
  
  if (!contractAddress || !contractAddress.startsWith('0x')) {
    console.error("❌ Contract address required!");
    console.error("Usage:");
    console.error("  CONTRACT_ADDRESS=0x... npx hardhat run scripts/verify.js --network avalanche");
    console.error("  Or: npx hardhat run scripts/verify.js --network avalanche --address 0x...");
    process.exit(1);
  }

  console.log(`Verifying contract at ${contractAddress} on Snowtrace...`);

  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: [], // DepositRouter has no constructor arguments
    });
    
    console.log(`✅ Contract verified successfully!`);
    console.log(`View on Snowtrace: https://snowtrace.io/address/${contractAddress}#code`);
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("✅ Contract is already verified!");
    } else {
      console.error("❌ Verification failed:", error.message);
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

