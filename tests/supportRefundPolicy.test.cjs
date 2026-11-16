const {test} = require('node:test');
const assert = require('node:assert/strict');
const {appleRefundEvent,googleRefundEvent,googleRefundToken,shouldApplyRefund} = require('../dist/supportRefundPolicy');
const appleProduct = 'com.wegig.mobile.support.small';
const googleProduct = 'com.wegig.app.support.small';
const now = Date.now()-10000;
const transaction = {transactionId:'10000001',productId:appleProduct,type:'Consumable',quantity:1,revocationDate:now-1000};
const notification = () => ({packageName:'com.wegig.app',eventTimeMillis:String(now),voidedPurchaseNotification:{productType:2,refundType:1,purchaseToken:'private-store-token'}});
const purchase = () => ({productLineItem:[{productId:googleProduct,productOfferDetails:{quantity:1,refundableQuantity:0}}],purchaseStateContext:{purchaseState:'CANCELLED'}});
test('Apple refund and reversal affect only the exact transaction and environment',()=>{
 const refund = appleRefundEvent({notificationType:'REFUND',signedDate:now},transaction,'production');
 assert.equal(refund.transactionKey,transaction.transactionId); assert.equal(refund.environment,'production'); assert.equal(refund.revokedAt.getTime(),now-1000);
 const reversal = appleRefundEvent({notificationType:'REFUND_REVERSED',signedDate:now+1000},transaction,'sandbox');
 assert.equal(reversal.revokedAt,null); assert.equal(reversal.environment,'sandbox');
});
test('refund requests and declines do not revoke a contribution',()=>{
 for(const notificationType of ['CONSUMPTION_REQUEST','REFUND_DECLINED','ONE_TIME_CHARGE','TEST']) assert.equal(appleRefundEvent({notificationType,signedDate:now},transaction,'production'),null);
});
test('foreign products are ignored; malformed support transactions fail closed',()=>{
 assert.equal(appleRefundEvent({notificationType:'REFUND',signedDate:now},{...transaction,productId:'other'},'production'),null);
 assert.throws(()=>appleRefundEvent({notificationType:'REFUND',signedDate:now},{...transaction,revocationDate:undefined},'production'));
 assert.throws(()=>appleRefundEvent({notificationType:'REFUND',signedDate:Date.now()+600000},transaction,'production'));
});
test('stale or duplicate notifications cannot undo a newer refund decision',()=>{
 const event = appleRefundEvent({notificationType:'REFUND',signedDate:now},transaction,'production');
 const previous = {eventAt:new Date(now+2000),revokedAt:null};
 assert.equal(shouldApplyRefund(previous,event),false);
 assert.equal(shouldApplyRefund({...event},event),false);
 assert.equal(shouldApplyRefund({eventAt:event.eventAt,revokedAt:null},event),true);
 assert.equal(shouldApplyRefund({...event},{...event,revokedAt:null}),false);
});
test('Google ignores subscriptions and refuses another package',()=>{
 assert.equal(googleRefundToken({...notification(),voidedPurchaseNotification:{productType:1}}),null);
 assert.throws(()=>googleRefundToken({...notification(),packageName:'other'}));
 assert.throws(()=>googleRefundToken({...notification(),voidedPurchaseNotification:{productType:2,refundType:99,purchaseToken:'token'}}));
});
test('Google refund identity is hashed and test purchases stay sandbox',()=>{
 const result=googleRefundEvent(notification(),'private-store-token',{...purchase(),testPurchaseContext:{}});
 assert.match(result.transactionKey,/^[a-f0-9]{64}$/); assert.equal(result.environment,'sandbox'); assert.equal(JSON.stringify(result).includes('private-store-token'),false);
});
test('Google cancellation needs Publisher confirmation; no unrelated SKU is affected',()=>{
 const cancelled={packageName:'com.wegig.app',eventTimeMillis:String(now),oneTimeProductNotification:{notificationType:2,purchaseToken:'token',sku:googleProduct}};
 const paid = purchase(); paid.purchaseStateContext.purchaseState='PURCHASED'; paid.productLineItem[0].productOfferDetails.refundableQuantity=1;
 assert.throws(()=>googleRefundEvent(cancelled,'token',paid),error=>error.code==='REFUND_STATE_NOT_READY');
 assert.equal(googleRefundEvent(cancelled,'token',purchase()).productId,googleProduct);
 assert.throws(()=>googleRefundEvent({...cancelled,oneTimeProductNotification:{...cancelled.oneTimeProductNotification,sku:'wrong'}},'token',purchase()));
});
test('partial quantity refunds wait for zero refundable quantity',()=>{
 const event=notification();event.voidedPurchaseNotification.refundType=2;
 const paid = purchase(); paid.purchaseStateContext.purchaseState='PURCHASED'; paid.productLineItem[0].productOfferDetails.refundableQuantity=1;
 assert.throws(()=>googleRefundEvent(event,'token',paid));
 assert.ok(googleRefundEvent(event,'token',purchase()).revokedAt);
});

test('Google push claims must match the configured audience and verified service account',()=>{
 const {requireGooglePushIdentity}=require('../dist/supportRefundPolicy');
 const expected={email:'push@example.invalid',email_verified:true,aud:'https://example.invalid/push',iss:'https://accounts.google.com'};
 assert.doesNotThrow(()=>requireGooglePushIdentity(expected,expected.aud,expected.email));
 for(const patch of [{email:'attacker@example.invalid'},{email_verified:false},{aud:'wrong'},{iss:'https://attacker.invalid'}]) assert.throws(()=>requireGooglePushIdentity({...expected,...patch},expected.aud,expected.email),error=>error.code==='INVALID_PUSH_IDENTITY');
});
