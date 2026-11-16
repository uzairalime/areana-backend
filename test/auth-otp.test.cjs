require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcrypt');
const { AuthService } = require('../src/auth/auth.service');

function setup(initialRecords = []) {
  const records = [...initialRecords];
  const sent = [];
  const logs = [];
  let nextId = 0;
  const otpCode = {
    count: async ({ where }) => records.filter((record) =>
      record.email === where.email && record.createdAt >= where.createdAt.gte,
    ).length,
    create: async ({ data }) => {
      const record = { ...data, id: `new-${++nextId}`, createdAt: new Date() };
      records.push(record);
      return record;
    },
    delete: async ({ where }) => {
      const index = records.findIndex((record) => record.id === where.id);
      assert.notEqual(index, -1);
      return records.splice(index, 1)[0];
    },
  };
  const mail = { sendOtp: async (email, code) => { sent.push({ email, code }); } };
  const config = { get: (key) => ({ 'smtp.host': 'localhost', 'smtp.port': 1025 })[key] };
  const auth = new AuthService({ otpCode }, {}, config, mail, {});
  auth.logger.error = (message) => logs.push(message);
  return { auth, records, sent, logs, otpCode, mail };
}

function isDeliveryUnavailable(error) {
  assert.equal(error.getStatus(), 503);
  assert.equal(error.message, 'Unable to send login code. Please try again later.');
  return true;
}

test('stores a hashed, expiring OTP before sending and preserves the success response', async () => {
  const { auth, records, mail } = setup();
  let deliveredCode;
  mail.sendOtp = async (email, code) => {
    assert.equal(email, 'player@example.com');
    assert.match(code, /^\d{6}$/);
    assert.equal(records.length, 1);
    assert.notEqual(records[0].codeHash, code);
    assert.equal(await bcrypt.compare(code, records[0].codeHash), true);
    deliveredCode = code;
  };
  const started = Date.now();
  assert.deepEqual(await auth.requestOtp({ email: ' Player@Example.com ' }), {
    message: 'Login code sent to your email',
  });
  assert.ok(deliveredCode);
  assert.equal(records.length, 1);
  assert.equal(records[0].email, 'player@example.com');
  assert.ok(records[0].expiresAt.getTime() >= started + 10 * 60_000);
  assert.ok(records[0].expiresAt.getTime() <= Date.now() + 10 * 60_000);
});

test('failed email delivery removes only its own OTP and logs no provider secrets', async () => {
  const previous = { id: 'previous', email: 'player@example.com', createdAt: new Date() };
  const unrelated = { id: 'unrelated', email: 'other@example.com', createdAt: new Date() };
  const { auth, records, mail, logs } = setup([previous, unrelated]);
  mail.sendOtp = async () => {
    throw Object.assign(new Error('password=provider-secret'), {
      code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535,
      response: 'provider-secret',
    });
  };
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), isDeliveryUnavailable);
  assert.deepEqual(records, [previous, unrelated]);
  assert.match(logs.join('\n'), /localhost:1025/);
  assert.match(logs.join('\n'), /EAUTH/);
  assert.doesNotMatch(logs.join('\n'), /provider-secret/);
});

test('repeated failed deliveries do not exhaust the hourly quota', async () => {
  const { auth, records, mail } = setup();
  mail.sendOtp = async () => { throw new Error('SMTP unavailable'); };
  for (let attempt = 0; attempt < 6; attempt++) {
    await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), isDeliveryUnavailable);
    assert.equal(records.length, 0);
  }
  mail.sendOtp = async () => {};
  await auth.requestOtp({ email: 'player@example.com' });
  assert.equal(records.length, 1);
});

test('five recent codes return 429 without creating or sending another code', async () => {
  const recent = Array.from({ length: 5 }, (_, index) => ({
    id: `sent-${index}`, email: 'player@example.com', createdAt: new Date(),
  }));
  const { auth, records, sent } = setup(recent);
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), (error) => {
    assert.equal(error.getStatus(), 429);
    return true;
  });
  assert.deepEqual(records, recent);
  assert.equal(sent.length, 0);
});

test('cleanup failure is logged and still returns a delivery error', async () => {
  const { auth, otpCode, mail, logs } = setup();
  mail.sendOtp = async () => { throw new Error('SMTP unavailable'); };
  otpCode.delete = async () => { throw new Error('database unavailable'); };
  await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), isDeliveryUnavailable);
  assert.match(logs.join('\n'), /Failed to remove an undelivered OTP record/);
});

for (const operation of ['count', 'create']) {
  test(`database ${operation} failures are not misreported as email delivery failures`, async () => {
    const { auth, otpCode, sent, logs } = setup();
    const failure = new Error('database unavailable');
    otpCode[operation] = async () => { throw failure; };
    await assert.rejects(auth.requestOtp({ email: 'player@example.com' }), (error) => error === failure);
    assert.equal(sent.length, 0);
    assert.equal(logs.length, 0);
  });
}
