import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { PaymongoService } from './paymongo.service';

const SECRET = 'whsk_test_secret';
const make = (env: Record<string, string> = {}) =>
  new PaymongoService({
    get: (k: string) => ({ PAYMONGO_SECRET_KEY: 'sk_test_abc', PAYMONGO_WEBHOOK_SECRET: SECRET, ...env })[k],
  } as any);
const sign = (t: string, body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

describe('PaymongoService.verifyWebhookSignature', () => {
  const body = JSON.stringify({ data: { id: 'evt_1' } });
  const t = '1700000000';

  it('accepts a valid test-mode signature (te)', () => {
    expect(() => make().verifyWebhookSignature(Buffer.from(body), `t=${t},te=${sign(t, body)},li=`)).not.toThrow();
  });

  it('accepts a valid live-mode signature (li) when a live key is configured', () => {
    const svc = make({ PAYMONGO_SECRET_KEY: 'sk_live_abc' });
    expect(() => svc.verifyWebhookSignature(body, `t=${t},te=,li=${sign(t, body)}`)).not.toThrow();
  });

  it('rejects a test signature in live mode', () => {
    const svc = make({ PAYMONGO_SECRET_KEY: 'sk_live_abc' });
    expect(() => svc.verifyWebhookSignature(body, `t=${t},te=${sign(t, body)},li=`)).toThrow(UnauthorizedException);
  });

  it('rejects a tampered body, wrong secret, missing or malformed header', () => {
    const svc = make();
    expect(() => svc.verifyWebhookSignature(body + ' ', `t=${t},te=${sign(t, body)}`)).toThrow(UnauthorizedException);
    expect(() => svc.verifyWebhookSignature(body, `t=${t},te=${sign(t, body, 'other')}`)).toThrow(UnauthorizedException);
    expect(() => svc.verifyWebhookSignature(body, undefined)).toThrow(UnauthorizedException);
    expect(() => svc.verifyWebhookSignature(body, 'garbage')).toThrow(UnauthorizedException);
    expect(() => svc.verifyWebhookSignature(undefined, `t=${t},te=x`)).toThrow(UnauthorizedException);
  });

  it('fails closed when no webhook secret is configured', () => {
    const svc = make({ PAYMONGO_WEBHOOK_SECRET: '' });
    expect(() => svc.verifyWebhookSignature(body, `t=${t},te=${sign(t, body)}`)).toThrow(UnauthorizedException);
  });

  it('enforces the optional timestamp tolerance', () => {
    const svc = make({ PAYMONGO_WEBHOOK_TOLERANCE_SECONDS: '300' });
    const header = `t=${t},te=${sign(t, body)}`;
    expect(() => svc.verifyWebhookSignature(body, header, Number(t) * 1000 + 10_000)).not.toThrow();
    expect(() => svc.verifyWebhookSignature(body, header, Number(t) * 1000 + 3_600_000)).toThrow(UnauthorizedException);
  });
});

describe('PaymongoService parsing', () => {
  it('normalises a flat Payment Link resource', () => {
    const link = PaymongoService.parseLink({
      id: 'link_1', amount: 50000, currency: 'PHP', status: 'active', url: 'https://pm.link/h/test/AbC123',
      reference_number: 'AbC123', remarks: 'RUNFLOW-PAYMENT-9', metadata: { a: 'b' },
    });
    expect(link).toMatchObject({
      id: 'link_1', referenceNumber: 'AbC123', checkoutUrl: 'https://pm.link/h/test/AbC123',
      amountCentavos: 50000, archived: false, remarks: 'RUNFLOW-PAYMENT-9', metadata: { a: 'b' },
    });
    expect(PaymongoService.parseLink({ id: 'l', status: 'archived', amount: 1 }).archived).toBe(true);
  });

  it('normalises the paid-payments list defensively', () => {
    const list = PaymongoService.parsePayments({
      data: [
        { id: 'pay_1', amount: 50000, currency: 'php', status: 'paid', source: { type: 'gcash' }, paid_at: 1700000000 },
        { id: 'pay_2', attributes: { amount: 100, payment_method: { type: 'card' } } }, // wrapped, status implied by filter
        { id: 'pay_3', amount: 5, status: 'failed' }, // not paid -> dropped
        { amount: 5 }, // no id -> dropped
      ],
    });
    expect(list.map((p) => p.id)).toEqual(['pay_1', 'pay_2']);
    expect(list[0]).toMatchObject({ amountCentavos: 50000, currency: 'PHP', method: 'gcash' });
    expect(list[0].paidAt?.getTime()).toBe(1700000000 * 1000);
    expect(list[1]).toMatchObject({ amountCentavos: 100, method: 'card' });
    expect(PaymongoService.parsePayments({ data: [{ id: 'p' }] })[0].amountCentavos).toBeNaN(); // fails the amount check later
  });
});

describe('PaymongoService API calls', () => {
  afterEach(() => jest.restoreAllMocks());
  const ok = (data: any, status = 200) => new Response(JSON.stringify({ data }), { status });

  it('POST /payment_links: flat body with currency, Basic auth (secret key as username, empty password)', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({ id: 'link_1', amount: 12345, currency: 'PHP', url: 'u', status: 'active' }, 201),
    );
    const link = await make({ PAYMONGO_BASE_URL: 'https://api.paymongo.com/v1/' }).createPaymentLink({
      amountCentavos: 12345, description: 'x', remarks: 'r', metadata: { k: 'v' },
    });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.paymongo.com/v1/payment_links');
    expect(init.method).toBe('POST');
    expect((init.headers as any).Authorization).toBe(`Basic ${Buffer.from('sk_test_abc:').toString('base64')}`);
    expect(JSON.parse(init.body as string)).toEqual({ amount: 12345, currency: 'PHP', description: 'x', remarks: 'r', metadata: { k: 'v' } });
    expect(link).toMatchObject({ id: 'link_1', checkoutUrl: 'u' });
  });

  it('lists paid payments, archives with PATCH {archive:true}, and fetches a link', async () => {
    const spy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'pay_1', amount: 100, status: 'paid' }] }), { status: 200 }))
      .mockResolvedValueOnce(ok({ id: 'link_1', status: 'archived' }))
      .mockResolvedValueOnce(ok({ id: 'link_1', status: 'active', amount: 100 }));
    const svc = make();
    expect((await svc.listPaidPayments('link_1'))[0].id).toBe('pay_1');
    await svc.archivePaymentLink('link_1');
    expect((await svc.getPaymentLink('link_1')).id).toBe('link_1');
    const calls = spy.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe('https://api.paymongo.com/v1/payment_links/link_1/payments?status=paid');
    expect(calls[1][0]).toBe('https://api.paymongo.com/v1/payment_links/link_1');
    expect(calls[1][1].method).toBe('PATCH');
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ archive: true });
    expect(calls[2][1].method).toBe('GET');
  });

  it('rejects amounts below the minimum and does not leak provider errors', async () => {
    await expect(make().createPaymentLink({ amountCentavos: 50, description: 'x' })).rejects.toThrow();
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: 'invalid_request_body', detail: 'secret internal detail' }] }), { status: 400 }),
    );
    await expect(make().createPaymentLink({ amountCentavos: 5000, description: 'x' })).rejects.toThrow(
      'The payment provider rejected the request',
    );
  });

  it('maps a timeout to 503 and a missing key to 503', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(make().createPaymentLink({ amountCentavos: 5000, description: 'x' })).rejects.toThrow(/too long/);
    await expect(make({ PAYMONGO_SECRET_KEY: '' }).createPaymentLink({ amountCentavos: 5000, description: 'x' })).rejects.toThrow(/not configured/);
  });
});