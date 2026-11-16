const {test,after} = require('node:test');
const assert = require('node:assert/strict');
const express=require('express');
if(!process.env.SUPPORT_TEST_DATABASE_URL) throw new Error('Run notification tests with a dedicated SUPPORT_TEST_DATABASE_URL.');
const target=new URL(process.env.SUPPORT_TEST_DATABASE_URL);
if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)||!target.pathname.endsWith('_test'))throw new Error('A local test database ending in _test is required.');
process.env.DATABASE_URL=process.env.SUPPORT_TEST_DATABASE_URL;
process.env.APPLE_IAP_APP_ID='6778116125';
process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE='https://example.invalid/support/notifications/google';
process.env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT='test-push@example.invalid';
process.env.GOOGLE_PLAY_PUBSUB_SUBSCRIPTION='projects/test/subscriptions/test';
const prisma=require('../dist/prisma').default;
const router=require('../dist/supportNotifications').default;
const app=express(); app.use(express.json());app.use('/support/notifications',router);
let server;
const ready=new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
async function post(path,body,headers={}){await ready;return fetch(`http://127.0.0.1:${server.address().port}/support/notifications/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
after(async()=>{await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
test('notifications are closed until explicitly configured',async()=>{
 delete process.env.SUPPORT_NOTIFICATIONS_ENABLED;
 assert.equal((await post('google',{})).status,503);
});
test('unsigned Google bodies cannot revoke purchases',async()=>{
 process.env.SUPPORT_NOTIFICATIONS_ENABLED='true';
 assert.equal((await post('google',{message:{data:Buffer.from(JSON.stringify({packageName:'com.wegig.app',voidedPurchaseNotification:{productType:2,purchaseToken:'forged'}})).toString('base64')}})).status,401);
});
test('Apple rejects unsigned JSON, malformed and forged JWS payloads',async()=>{
 process.env.SUPPORT_NOTIFICATIONS_ENABLED='true';
 assert.equal((await post('apple/production',{notificationType:'REFUND',data:{transactionId:'123'}})).status,400);
 assert.equal((await post('apple/production',{signedPayload:'invalid'})).status,400);
 assert.equal((await post('apple/production',{signedPayload:'e30.e30.e30'})).status,401);
});
test('unknown environment endpoints cannot select a permissive verifier',async()=>{
 process.env.SUPPORT_NOTIFICATIONS_ENABLED='true';
 assert.equal((await post('apple/unknown',{signedPayload:'e30.e30.e30'})).status,404);
});
