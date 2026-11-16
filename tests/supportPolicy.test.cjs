const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { checkGooglePurchase, googleAccountId, isSupportProduct } = require('../dist/supportPolicy');
const user = '11111111-1111-4111-8111-111111111111';
const product = 'com.wegig.app.support.small';
const original = process.env.IAP_TEST_USER_IDS;
afterEach(() => { if (original === undefined) delete process.env.IAP_TEST_USER_IDS; else process.env.IAP_TEST_USER_IDS = original; });
function purchase() { return { purchaseStateContext: { purchaseState: 'PURCHASED' }, obfuscatedExternalAccountId: googleAccountId(user), productLineItem: [{ productId: product, productOfferDetails: { quantity: 1, refundableQuantity: 1 } }], purchaseCompletionTime: '2026-11-16T12:00:00Z' }; }
function rejects(data, code) { assert.throws(() => checkGooglePurchase(data, user, product, 'secret-token'), error => error.code === code); }
test('accepts a paid purchase and stores a hash instead of the token', () => {
 const result = checkGooglePurchase(purchase(), user, product, 'secret-token');
 assert.equal(result.environment, 'production'); assert.match(result.transactionKey, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(result).includes('secret-token'), false);
});
test('pending and cancelled payments cannot grant supporter status', () => {
 for (const [state, code] of [['PENDING','PAYMENT_PENDING'], ['CANCELLED','PAYMENT_NOT_PURCHASED']]) { const data = purchase(); data.purchaseStateContext.purchaseState = state; rejects(data, code); }
});
test('rejects purchases bound to another account', () => { const data = purchase(); data.obfuscatedExternalAccountId = googleAccountId('someone-else'); rejects(data, 'PURCHASE_ACCOUNT_MISMATCH'); });
test('rejects mismatched products, multiple items and unexpected quantities', () => {
 const wrongProduct = purchase(); wrongProduct.productLineItem[0].productId = 'other'; rejects(wrongProduct,'PURCHASE_PRODUCT_MISMATCH');
 const multiple = purchase(); multiple.productLineItem.push(multiple.productLineItem[0]); rejects(multiple,'PURCHASE_PRODUCT_MISMATCH');
 const quantity = purchase(); quantity.productLineItem[0].productOfferDetails.quantity = 2; rejects(quantity,'PURCHASE_PRODUCT_MISMATCH');
});
test('rejects refunded purchases and invalid dates', () => { const refunded = purchase(); refunded.productLineItem[0].productOfferDetails.refundableQuantity = 0; rejects(refunded,'PURCHASE_REFUNDED'); const date = purchase(); date.purchaseCompletionTime = 'invalid'; rejects(date,'INVALID_PURCHASE_DATE'); });
test('sandbox requires an explicit test account and stays sandbox', () => {
 delete process.env.IAP_TEST_USER_IDS; const data = purchase(); data.testPurchaseContext = {}; rejects(data,'TEST_PURCHASE_NOT_ALLOWED');
 process.env.IAP_TEST_USER_IDS = user; assert.equal(checkGooglePurchase(data,user,product,'test-token').environment,'sandbox');
});
test('allowlist accepts only the seven exact IDs for each store', () => {
 for (const suffix of ['small','medium','large','extra1','extra20','extra50','extra100']) { assert.equal(isSupportProduct('google','com.wegig.app.support.'+suffix),true); assert.equal(isSupportProduct('apple','com.wegig.mobile.support.'+suffix),true); }
 assert.equal(isSupportProduct('apple',product),false); assert.equal(isSupportProduct('google',product+'.forged'),false);
});
