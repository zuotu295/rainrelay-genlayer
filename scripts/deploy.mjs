import { readFile } from 'node:fs/promises';
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { CalldataAddress, TransactionHashVariant, TransactionStatus } from 'genlayer-js/types';

const smokeMode = process.argv.includes('--smoke');
const settlementMode = process.argv.includes('--settle-e2e');

async function testClient(key) {
  const account = createAccount(key);
  const client = createClient({ chain: studionet, account });
  if (!key) {
    await client.request({ method: 'sim_fundAccount', params: [account.address, 10 ** 18] });
  }
  return client;
}

const key = process.env.STUDIONET_PRIVATE_KEY;
if (!key && process.env.STUDIONET_FAUCET !== '1') {
  throw new Error('Set STUDIONET_PRIVATE_KEY or STUDIONET_FAUCET=1.');
}
const client = await testClient(key);

let address = process.env.STUDIONET_CONTRACT_ADDRESS;
if (!address && (smokeMode || settlementMode)) {
  const deployment = JSON.parse(await readFile(new URL('../src/deployment.json', import.meta.url), 'utf8'));
  address = deployment.address;
}
if (!address && !smokeMode && !settlementMode) {
  const code = await readFile(new URL('../contracts/rain_relay.py', import.meta.url), 'utf8');
  const deployHash = await client.deployContract({ code, args: [], leaderOnly: false });
  console.log('Deploy', deployHash);
  const deployment = await finalized(deployHash);
  address = deployment.data?.contract_address ?? deployment.to_address;
}
if (!address) throw new Error('No Studionet contract address is configured.');
console.log('Address', address);

async function finalized(hash) {
  const receipt = await client.waitForTransactionReceipt({
    hash, status: TransactionStatus.FINALIZED, interval: 4000, retries: 100,
  });
  const leader = receipt.consensus_data?.leader_receipt?.find((entry) => entry.mode === 'leader');
  if (leader?.execution_result !== 'SUCCESS') {
    throw new Error(leader?.genvm_result?.stderr || leader?.result?.payload || 'Contract execution failed');
  }
  return receipt;
}

const read = async (id) => JSON.parse(await client.readContract({
  address,
  functionName: 'get_agreement',
  args: [id],
  transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
}));

const list = async () => {
  const result = await client.readContract({
    address,
    functionName: 'list_agreements',
    args: [0],
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
  return typeof result === 'string' ? JSON.parse(result) : result;
};

const write = async (signer, method, args) => {
  const hash = await signer.writeContract({
    address, functionName: method, args, value: 0n, leaderOnly: false,
  });
  console.log(method, hash);
  await finalized(hash);
  console.log('FINALIZED SUCCESS', method, hash);
  return hash;
};

const utcDate = (offset = 0) => {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

const addDays = (date, offset) => {
  const value = new Date(date + 'T00:00:00.000Z');
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

const e2ePrefix = 'RainRelay E2E settlement ';

function verifySettlement(agreement) {
  const start = new Date(agreement.start + 'T00:00:00.000Z');
  const end = new Date(agreement.end + 'T00:00:00.000Z');
  const expectedDays = Math.round((end - start) / 86400000) + 1;
  if (!Array.isArray(agreement.daily) || agreement.daily.length !== expectedDays) {
    throw new Error('Settlement daily observation count does not match the agreed date window');
  }
  if (agreement.daily.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error('Settlement contains an invalid daily precipitation value');
  }
  const total = agreement.daily.reduce((sum, value) => sum + value, 0);
  if (Number(agreement.total) !== total) {
    throw new Error('Settlement total does not equal the sum of daily observations');
  }
  const expectedStatus = total >= Number(agreement.threshold) ? 'CREDIT_DUE' : 'BELOW_TRIGGER';
  if (agreement.status === 'REDEEMED') {
    if (expectedStatus !== 'CREDIT_DUE' || !agreement.order) {
      throw new Error('Redeemed agreement does not contain a valid triggered credit');
    }
  } else if (agreement.status !== expectedStatus) {
    throw new Error(`Settlement status mismatch: expected ${expectedStatus}, received ${agreement.status}`);
  }
  return { expectedDays, total, expectedStatus };
}

async function findE2EAgreement() {
  const agreements = await list();
  return agreements
    .filter((item) => !item.replay && typeof item.title === 'string' && item.title.startsWith(e2ePrefix))
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}

async function createE2EAgreement() {
  const guest = await testClient();
  const start = utcDate(1);
  const end = start;
  const title = e2ePrefix + utcDate(0);
  const proposal = await client.writeContract({
    address,
    functionName: 'propose',
    args: [
      title,
      new CalldataAddress(Buffer.from(guest.account.address.slice(2), 'hex')),
      5150,
      -12,
      start,
      end,
      100,
      25,
    ],
    value: 0n,
    leaderOnly: false,
  });
  console.log('E2E propose', proposal);
  await finalized(proposal);

  const proposalReceipt = await client.getTransaction({ hash: proposal });
  const leader = proposalReceipt.consensus_data?.leader_receipt?.find((entry) => entry.mode === 'leader');
  if (!leader?.result?.raw) throw new Error('Could not decode the finalized proposal ID');
  const { abi } = await import('genlayer-js');
  const id = Number(abi.calldata.decode(Buffer.from(leader.result.raw, 'base64').subarray(1)));
  if (!Number.isSafeInteger(id) || id < 3) throw new Error('Decoded proposal ID is invalid');

  const proposed = await read(id);
  if (proposed.status !== 'PROPOSED' || proposed.replay) {
    throw new Error('New live agreement was not persisted in PROPOSED state');
  }
  await write(guest, 'accept', [id]);
  const accepted = await read(id);
  if (accepted.status !== 'ACCEPTED' || accepted.replay) {
    throw new Error('Customer acceptance was not persisted');
  }
  console.log('E2E agreement accepted', JSON.stringify({
    id,
    title: accepted.title,
    start: accepted.start,
    end: accepted.end,
    settlementEarliest: addDays(accepted.end, 8),
    status: accepted.status,
  }));
  return accepted;
}

async function settleE2EAgreement({ createIfMissing = false } = {}) {
  let agreement = await findE2EAgreement();
  if (!agreement) {
    if (!createIfMissing) throw new Error('No live RainRelay E2E agreement exists; run the smoke workflow first.');
    agreement = await createE2EAgreement();
  }

  if (agreement.status === 'PROPOSED') {
    throw new Error('E2E agreement is PROPOSED but not ACCEPTED; manual recovery is required.');
  }

  if (['CREDIT_DUE', 'BELOW_TRIGGER', 'REDEEMED'].includes(agreement.status)) {
    const result = verifySettlement(agreement);
    console.log('E2E settlement already finalized', JSON.stringify({
      title: agreement.title,
      status: agreement.status,
      totalTenthsMm: result.total,
      totalMm: result.total / 10,
      daily: agreement.daily,
    }));
    return agreement;
  }

  if (agreement.status !== 'ACCEPTED') {
    throw new Error(`Unexpected E2E agreement state: ${agreement.status}`);
  }

  const earliest = addDays(agreement.end, 8);
  const today = utcDate(0);
  if (today < earliest) {
    console.log('E2E settlement pending archive maturity', JSON.stringify({
      title: agreement.title,
      status: agreement.status,
      today,
      earliestSettlementDate: earliest,
    }));
    return agreement;
  }

  const id = Number(agreement.id);
  const hash = await write(client, 'settle', [id]);
  agreement = await read(id);
  const result = verifySettlement(agreement);
  console.log('E2E settlement finalized', JSON.stringify({
    id,
    transaction: hash,
    title: agreement.title,
    start: agreement.start,
    end: agreement.end,
    dailyTenthsMm: agreement.daily,
    totalTenthsMm: result.total,
    totalMm: result.total / 10,
    thresholdTenthsMm: agreement.threshold,
    status: agreement.status,
  }));
  return agreement;
}

if (smokeMode) {
  for (const [id, expectedStatus] of [[1, 'CREDIT_DUE'], [2, 'BELOW_TRIGGER']]) {
    let agreement = await read(id);
    if (agreement.status === 'ACCEPTED') {
      await write(client, 'settle', [id]);
      agreement = await read(id);
    }
    const result = verifySettlement(agreement);
    if (agreement.status !== expectedStatus || result.expectedStatus !== expectedStatus) {
      throw new Error(`Replay ${id} did not finalize as ${expectedStatus}`);
    }
    console.log('Finalized replay', id, JSON.stringify(agreement));
  }
  await settleE2EAgreement({ createIfMissing: true });
}

if (settlementMode) {
  await settleE2EAgreement({ createIfMissing: false });
}
