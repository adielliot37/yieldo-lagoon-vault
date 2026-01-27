#!/usr/bin/env node
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexerRoot = join(__dirname, '..');

dotenv.config({ path: join(indexerRoot, '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'yieldo';

if (!MONGODB_URI) {
  console.error('❌ Missing MONGODB_URI in .env file');
  process.exit(1);
}

async function getAllSnapshotDates() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB_NAME);
    const colSnapshots = db.collection('snapshots');
    
    const dates = await colSnapshots.distinct('date');
    const sortedDates = dates.sort();
    
    await client.close();
    return sortedDates;
  } catch (error) {
    console.error('Error fetching snapshot dates:', error);
    if (client) await client.close();
    throw error;
  }
}

async function recalculateDate(date) {
  return new Promise((resolve, reject) => {
    console.log(`\n📊 Recalculating snapshot for ${date}...`);
    const child = spawn(process.execPath, [join(indexerRoot, 'src', 'index.js'), 'backfill-snapshot', date], {
      cwd: indexerRoot,
      stdio: 'inherit',
      env: { ...process.env, PATH: process.env.PATH },
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Successfully recalculated ${date}`);
        resolve();
      } else {
        console.error(`❌ Failed to recalculate ${date} (exit code: ${code})`);
        reject(new Error(`Backfill failed for ${date}`));
      }
    });
    
    child.on('error', (error) => {
      console.error(`❌ Error running backfill for ${date}:`, error);
      reject(error);
    });
  });
}

async function main() {
  console.log('🔍 Fetching all snapshot dates from database...');
  const dates = await getAllSnapshotDates();
  
  if (dates.length === 0) {
    console.log('⚠️  No snapshots found in database. Nothing to recalculate.');
    return;
  }
  
  console.log(`\n📅 Found ${dates.length} snapshot date(s):`);
  dates.forEach((date, i) => console.log(`   ${i + 1}. ${date}`));
  
  console.log('\n🔄 Recalculating snapshots in chronological order...');
  console.log('   (This ensures each day\'s AUM is based on the previous day\'s corrected AUM)\n');
  
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    try {
      await recalculateDate(date);
    } catch (error) {
      console.error(`\n❌ Stopping recalculation due to error at ${date}`);
      console.error('   You can resume by running this script again (it will recalculate all dates)');
      process.exit(1);
    }
  }
  
  console.log(`\n✅ Successfully recalculated all ${dates.length} snapshot(s)!`);
  console.log('   AUM values should now be correct and cumulative.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
