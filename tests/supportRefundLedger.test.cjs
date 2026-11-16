const {test,after} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
// Deliberately never fall back to DATABASE_URL: these are test-only writes.
const target=process.env.SUPPORT_TEST_DATABASE_URL;
if (!target) throw new Error('Set SUPPORT_TEST_DATABASE_URL to a dedicated local PostgreSQL database ending in _test.');
const url=new URL(target);
if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Refund tests require a local dedicated database ending in _test.');
process.env.DATABASE_URL=target;
const prisma=require('../dist/prisma').default;
const {recordSupportPurchase,applySupportRefund,getSupporterStatus}=require('../dist/supportLedger');
const users=[]; const keys=[];
function fixture(environment='production') {
 const user='support-test-'+randomUUID(); users.push(user);
 const transactionKey=randomUUID(); keys.push(transactionKey);
 return {user,purchase:{platform:'apple',environment,transactionKey,productId:'com.wegig.mobile.support.small',purchasedAt:new Date()},event:{platform:'apple',environment,transactionKey,productId:'com.wegig.mobile.support.small',eventAt:new Date(),revokedAt:new Date()}};
}
after(async()=>{try{await prisma.supportPurchase.deleteMany({where:{userId:{in:users}}});await prisma.supportStoreState.deleteMany({where:{transactionKey:{in:keys}}});}finally{await prisma.$disconnect();}});
test('simultaneous duplicate verification records one contribution',async()=>{
 const {user,purchase}=fixture(); await Promise.all(Array.from({length:8},()=>recordSupportPurchase(user,purchase)));
 assert.equal(await prisma.supportPurchase.count({where:{userId:user}}),1);
 await assert.rejects(recordSupportPurchase('another-user',purchase),e=>e.code==='PURCHASE_ALREADY_CLAIMED');
});
test('refund before confirmation leaves a tombstone and blocks a stale verification',async()=>{
 const {user,purchase,event}=fixture(); await applySupportRefund(event);
 await assert.rejects(recordSupportPurchase(user,purchase),e=>e.code==='PURCHASE_REFUNDED');
 assert.equal(await prisma.supportPurchase.count({where:{userId:user}}),0);
});
test('refund and verification racing cannot leave an active refunded purchase',async()=>{
 for(let i=0;i<8;i++) {
  const {user,purchase,event}=fixture();
  const results=await Promise.allSettled([recordSupportPurchase(user,purchase),applySupportRefund(event)]);
  assert.equal(results[1].status,'fulfilled');
  assert.equal(await prisma.supportPurchase.count({where:{userId:user,revokedAt:null}}),0);
 }
});
test('another valid contribution preserves the badge; refunding both removes it',async()=>{
 const first=fixture(); const second=fixture(); second.user=first.user;
 await recordSupportPurchase(first.user,first.purchase); await recordSupportPurchase(first.user,second.purchase);
 await applySupportRefund(first.event); assert.equal((await getSupporterStatus(first.user)).isFoundingSupporter,true);
 await applySupportRefund(second.event); assert.equal((await getSupporterStatus(first.user)).isFoundingSupporter,false);
});
test('newer reversal restores status; duplicate and older events do not change it',async()=>{
 const {user,purchase,event}=fixture(); await recordSupportPurchase(user,purchase); await applySupportRefund(event);
 const reversal={...event,eventAt:new Date(event.eventAt.getTime()+1000),revokedAt:null};
 assert.equal(await applySupportRefund(reversal),true); assert.equal(await applySupportRefund(reversal),false);
 assert.equal(await applySupportRefund(event),false); assert.equal((await getSupporterStatus(user)).isFoundingSupporter,true);
});
test('sandbox events never revoke or grant production status',async()=>{
 const {user,purchase,event}=fixture(); await recordSupportPurchase(user,purchase);
 await applySupportRefund({...event,environment:'sandbox'}); assert.equal((await getSupporterStatus(user)).isFoundingSupporter,true);
 const test=fixture('sandbox');process.env.IAP_TEST_USER_IDS=test.user;await recordSupportPurchase(test.user,test.purchase);
 assert.deepEqual(await getSupporterStatus(test.user),{isFoundingSupporter:false,isTestSupporter:true});
 await applySupportRefund(test.event);assert.deepEqual(await getSupporterStatus(test.user),{isFoundingSupporter:false,isTestSupporter:false});
});
