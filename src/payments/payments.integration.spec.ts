// /**
//  * End-to-end test of both payment flows against a REAL database and a real HTTP server (so the
//  * raw-body webhook path is exercised). Only PayMongo's HTTP API is stubbed.
//  *
//  * Opt-in because it needs MySQL with all migrations applied:
//  *   PAYMENTS_IT=1 DB_HOST=127.0.0.1 DB_USERNAME=root DB_PASSWORD=... DB_NAME=runflow_test npx jest payments.integration
//  * It writes (and cleans up) its own rows; use a scratch database.
//  */
// import 'reflect-metadata';
// import { Test } from '@nestjs/testing';
// import { INestApplication, Module } from '@nestjs/common';
// import { NestExpressApplication } from '@nestjs/platform-express';
// import { ConfigModule } from '@nestjs/config';
// import { TypeOrmModule } from '@nestjs/typeorm';
// import { EventEmitterModule } from '@nestjs/event-emitter';
// import { createHmac } from 'crypto';
// import { join } from 'path';
// import { DataSource } from 'typeorm';
// import { dataSourceOptions } from '../data-source';
// import { PaymentsModule } from './payments.module';
// import { EmailModule } from '../email/email.module';
// import { PaymentsService } from './payments.service';
// import { PaymentSettlementService } from './payment-settlement.service';
// import { RegistrationsService } from '../registrations/registrations.service';
// import { EventsService } from '../events/events.service';
// import { Payment } from './entities/payment.entity';
// import { PaymentStatusLog } from './entities/payment-status-log.entity';
// import { User } from '../users/entities/user.entity';
// import { Organization } from '../organizations/entities/organization.entity';
// import { Event } from '../events/entities/event.entity';
// import { EventCategory } from '../events/entities/event-category.entity';
// import { Registration } from '../registrations/entities/registration.entity';
// import {
//   EventStatus,
//   PaymentPurpose,
//   PaymentStatus,
//   RegistrationStatus,
//   UserRole,
// } from '../common/enums';
// import { OrganizerEventPaymentsService } from 'src/organizer/organizer-event-payments.service';
// import { OrganizerFeeService } from 'src/organizer-fee/organizer-fee.service';

// const WEBHOOK_SECRET = 'whsk_it_secret';
// const run = process.env.PAYMENTS_IT === '1' ? describe : describe.skip;

// process.env.PAYMONGO_SECRET_KEY = 'sk_test_it';
// process.env.PAYMONGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
// process.env.PAYMONGO_BASE_URL = 'https://paymongo.invalid/v1';
// process.env.PAYMENT_EXPIRY_SWEEP_SECONDS = '0';
// process.env.PAYMENT_REFRESH_MIN_INTERVAL_SECONDS = '0';

// @Module({
//   imports: [
//     ConfigModule.forRoot({ isGlobal: true }),
//     TypeOrmModule.forRoot(dataSourceOptions),
//     EventEmitterModule.forRoot(),
//     EmailModule.forRoot({
//       defaultFrom: 'test@runflow.test',
//       smtp: { host: 'localhost', port: 2525, user: 'u', pass: 'p' },
//       templatesDir: join(process.cwd(), 'src/email/templates'),
//       dryRun: true,
//     }),
//     PaymentsModule,
//   ],
// })
// class TestAppModule {}

// run('PayMongo payments (integration)', () => {
//   let app: INestApplication;
//   let baseUrl: string;
//   let ds: DataSource;
//   let payments: PaymentsService;
//   let settlement: SettlementLike;
//   let fees: OrganizerFeeService;
//   let orgPayments: OrganizerEventPaymentsService;
//   let events: EventsService;
//   let registrations: RegistrationsService;

//   type SettlementLike = PaymentSettlementService;

//   // ---- PayMongo stub ---------------------------------------------------------------------
//   const realFetch = global.fetch;
//   let linkSeq = 0;
//   const links = new Map<string, any>(); // link id -> stored link resource
//   const calls: { method: string; path: string; body?: any }[] = [];
//   let failNextCreate = false;

//   const stubFetch = jest.fn(async (url: any, init?: any) => {
//     const u = String(url);
//     if (!u.startsWith('https://paymongo.invalid/v1')) return realFetch(url, init);
//     const path = u.replace('https://paymongo.invalid/v1', '');
//     const method = init?.method ?? 'GET';
//     const body = init?.body ? JSON.parse(init.body) : undefined;
//     calls.push({ method, path, body });
//     expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('sk_test_it:').toString('base64')}`);

//     if (method === 'POST' && path === '/links') {
//       if (failNextCreate) {
//         failNextCreate = false;
//         return new Response(JSON.stringify({ errors: [{ detail: 'boom' }] }), { status: 500 });
//       }
//       const id = `link_${++linkSeq}`;
//       const attrs = {
//         ...body.data.attributes, status: 'unpaid', archived: false, reference_number: `REF${linkSeq}`,
//         checkout_url: `https://pm.link/test/REF${linkSeq}`, payments: [],
//       };
//       links.set(id, { id, type: 'link', attributes: attrs });
//       return new Response(JSON.stringify({ data: links.get(id) }), { status: 200 });
//     }
//     const m = /^\/links\/([^/]+)(\/archive)?$/.exec(path);
//     if (m && links.has(m[1])) {
//       if (m[2]) links.get(m[1]).attributes.archived = true;
//       return new Response(JSON.stringify({ data: links.get(m[1]) }), { status: 200 });
//     }
//     return new Response('{}', { status: 404 });
//   });

//   /** Marks a stub link as paid at PayMongo and returns the event body PayMongo would POST. */
//   function payOnPayMongo(linkId: string, amount?: number, payId = `pay_${linkId}`) {
//     const link = links.get(linkId);
//     link.attributes.status = 'paid';
//     link.attributes.payments.push({
//       data: { id: payId, type: 'payment', attributes: { amount: amount ?? link.attributes.amount, currency: 'PHP', status: 'paid', source: { type: 'gcash' }, paid_at: Math.floor(Date.now() / 1000) } },
//     });
//     return {
//       data: { id: `evt_${payId}_${Math.random().toString(36).slice(2)}`, type: 'event', attributes: { type: 'link.payment.paid', livemode: false, data: JSON.parse(JSON.stringify(link)) } },
//     };
//   }

//   async function deliver(payload: any, opts: { sign?: boolean; secret?: string } = {}) {
//     const raw = JSON.stringify(payload);
//     const t = String(Math.floor(Date.now() / 1000));
//     const headers: Record<string, string> = { 'Content-Type': 'application/json' };
//     if (opts.sign !== false) {
//       const sig = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
//       headers['Paymongo-Signature'] = `t=${t},te=${sig},li=`;
//     }
//     const res = await realFetch(`${baseUrl}/webhooks/paymongo`, { method: 'POST', headers, body: raw });
//     return { status: res.status, json: await res.json().catch(() => null) };
//   }

//   // ---- seed ---------------------------------------------------------------------------------
//   const created = { users: [] as string[], orgs: [] as string[] };
//   let runner: User, otherRunner: User, organizer: User, otherOrganizer: User, admin: User;
//   let org: Organization;
//   let openEvent: Event, paidCat: EventCategory, freeCat: EventCategory;
//   let draftEvent: Event;
//   const uniq = Date.now().toString(36);

//   async function mkUser(name: string, role: UserRole) {
//     const u = await ds.getRepository(User).save(ds.getRepository(User).create({ email: `${name}.${uniq}@it.test`, role, passwordHash: 'x' }));
//     created.users.push(u.id);
//     return u;
//   }
//   const route = [[121, 14], [121.01, 14.01]];
//   async function mkEvent(status: EventStatus, name: string) {
//     const ev = await ds.getRepository(Event).save(ds.getRepository(Event).create({
//       organizationId: org.id, name, eventDate: '2030-01-01', venue: 'v', location: 'l', status,
//       registrationStart: new Date(Date.now() - 86_400_000), registrationEnd: new Date(Date.now() + 86_400_000),
//     }));
//     return ev;
//   }
//   const mkCat = (ev: Event, price: string, slots = 50) => {
//     const repo = ds.getRepository(EventCategory);
//     const cat = repo.create({
//       eventId: ev.id, name: `Cat ${price}`, distanceKm: '5', price, slotsTotal: slots, slotsRemaining: slots,
//       routeCoordinates: route,
//     } as any) as unknown as EventCategory;
//     return repo.save(cat);
//   };

//   const regDto = (categoryId: string, first = 'Juan') => ({
//     categoryId, firstName: first, lastName: 'Cruz', birthday: '1990-01-01', gender: 'male' as any,
//     mobileNumber: '09171234567', email: 'juan@it.test', emergencyContactName: 'Ma', emergencyContactNumber: '09170000000',
//   });
//   const actor = (u: User) => ({ id: u.id, role: u.role });
//   const paymentRow = (id: string) => ds.getRepository(Payment).findOneOrFail({ where: { id } });
//   const regRow = (id: string) => ds.getRepository(Registration).findOneOrFail({ where: { id } });
//   const slots = async (id: string) => (await ds.getRepository(EventCategory).findOneOrFail({ where: { id } })).slotsRemaining;

//   beforeAll(async () => {
//     jest.spyOn(global, 'fetch').mockImplementation(stubFetch as any);
//     const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
//     app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
//     app.setGlobalPrefix('api');
//     await app.listen(0);
//     baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}/api`;
//     ds = app.get(DataSource);
//     payments = app.get(PaymentsService);
//     settlement = app.get(PaymentSettlementService);
//     fees = app.get(OrganizerFeeService);
//     orgPayments = app.get(OrganizerEventPaymentsService);
//     events = app.get(EventsService);
//     registrations = app.get(RegistrationsService);

//     runner = await mkUser('runner', UserRole.RUNNER);
//     otherRunner = await mkUser('runner2', UserRole.RUNNER);
//     organizer = await mkUser('org', UserRole.ORGANIZER);
//     otherOrganizer = await mkUser('org2', UserRole.ORGANIZER);
//     admin = await mkUser('admin', UserRole.ADMIN);
//     org = await ds.getRepository(Organization).save(ds.getRepository(Organization).create({ ownerUserId: organizer.id, name: `Org ${uniq}` }));
//     await ds.getRepository(Organization).save(ds.getRepository(Organization).create({ ownerUserId: otherOrganizer.id, name: `Org2 ${uniq}` }));
//     openEvent = await mkEvent(EventStatus.REG_OPEN, `Open ${uniq}`);
//     paidCat = await mkCat(openEvent, '500.00');
//     freeCat = await mkCat(openEvent, '0.00');
//     draftEvent = await mkEvent(EventStatus.DRAFT, `Draft ${uniq}`);
//     await mkCat(draftEvent, '300.00');
//     await fees.setFee({ amountPesos: 0 }); // start with no organizer fee configured
//   });

//   afterAll(async () => {
//     const eventIds = (await ds.getRepository(Event).find({ where: { organizationId: org.id } })).map((e) => e.id);
//     if (eventIds.length) {
//       await ds.query(`DELETE FROM payments WHERE event_id IN (${eventIds.join(',')})`);
//       await ds.query(`DELETE FROM registrations WHERE event_id IN (${eventIds.join(',')})`);
//       await ds.query(`DELETE FROM events WHERE organization_id = ?`, [org.id]);
//     }
//     await ds.query(`DELETE FROM organizations WHERE owner_user_id IN (${created.users.join(',')})`);
//     await ds.query(`DELETE FROM notifications WHERE user_id IN (${created.users.join(',')})`).catch(() => undefined);
//     await ds.query(`DELETE FROM users WHERE id IN (${created.users.join(',')})`);
//     await ds.query(`DELETE FROM payment_webhook_events WHERE provider_event_id LIKE 'evt_pay_link_%'`);
//     await ds.query(`DELETE FROM organizer_fee_configs`);
//     await app.close();
//     jest.restoreAllMocks();
//   });

//   // ============================ Flow A: runner registration ===================================
//   describe('Flow A — runner registration', () => {
//     let reg: Registration;
//     let paymentId: string;
//     let linkId: string;

//     it('charges the DATABASE price, ignoring anything a client could send', async () => {
//       reg = await registrations.startRegistration(runner.id, regDto(paidCat.id) as any);
//       expect(reg.status).toBe(RegistrationStatus.PENDING_PAYMENT);

//       const res: any = await payments.createCheckout(reg.id, actor(runner));
//       expect(res.checkoutUrl).toMatch(/^https:\/\/pm\.link\//);
//       expect(res.amountCentavos).toBe(50_000);
//       paymentId = res.paymentId;

//       const create = calls.filter((c) => c.method === 'POST' && c.path === '/links').pop()!;
//       expect(create.body.data.attributes.amount).toBe(50_000);
//       expect(create.body.data.attributes.remarks).toBe(`RUNFLOW-PAYMENT-${paymentId}`);

//       const row = await paymentRow(paymentId);
//       expect(row).toMatchObject({ purpose: PaymentPurpose.RUNNER_REGISTRATION, status: PaymentStatus.PENDING, amountCentavos: 50_000, currency: 'PHP', registrationId: reg.id, eventId: openEvent.id });
//       expect(row.providerCheckoutId).toMatch(/^link_/);
//       expect(row.providerReferenceNumber).toMatch(/^REF/);
//       linkId = row.providerCheckoutId;
//     });

//     it('reuses the same link on retry instead of creating another', async () => {
//       const before = calls.filter((c) => c.method === 'POST' && c.path === '/links').length;
//       const again: any = await payments.createCheckout(reg.id, actor(runner));
//       expect(again.reused).toBe(true);
//       expect(again.paymentId).toBe(paymentId);
//       expect(calls.filter((c) => c.method === 'POST' && c.path === '/links').length).toBe(before);
//     });

//     it('does not let another runner start or read this payment (404, not 403)', async () => {
//       await expect(payments.createCheckout(reg.id, actor(otherRunner))).rejects.toThrow('Registration not found');
//       await expect(payments.getPaymentForActor(paymentId, actor(otherRunner))).rejects.toThrow('Payment not found');
//       await expect(payments.getStatusForRegistration(reg.id, actor(otherRunner))).rejects.toThrow('Registration not found');
//       expect((await payments.getPaymentForActor(paymentId, actor(runner))).status).toBe('pending');
//       expect((await payments.getPaymentForActor(paymentId, actor(admin))).status).toBe('pending');
//     });

//     it('opening/holding a pending link does NOT confirm the registration', async () => {
//       expect((await regRow(reg.id)).status).toBe(RegistrationStatus.PENDING_PAYMENT);
//       expect((await regRow(reg.id)).bibNumber).toBeNull();
//     });

//     it('rejects unsigned, wrongly signed and malformed webhooks and changes nothing', async () => {
//       const body = payOnPayMongo(linkId, undefined, 'pay_forged');
//       links.get(linkId).attributes.payments.pop(); // PayMongo did not really record it
//       links.get(linkId).attributes.status = 'unpaid';
//       expect((await deliver(body, { sign: false })).status).toBe(401);
//       expect((await deliver(body, { secret: 'wrong' })).status).toBe(401);
//       expect((await realFetch(`${baseUrl}/webhooks/paymongo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paymongo-Signature': 't=1,te=zz' }, body: '{}' })).status).toBe(401);
//       expect((await paymentRow(paymentId)).status).toBe(PaymentStatus.PENDING);
//       expect((await regRow(reg.id)).status).toBe(RegistrationStatus.PENDING_PAYMENT);
//     });

//     it('a signed link.payment.paid confirms the payment and the registration', async () => {
//       const event = payOnPayMongo(linkId);
//       const res = await deliver(event);
//       expect(res.status).toBe(200);

//       const p = await paymentRow(paymentId);
//       expect(p.status).toBe(PaymentStatus.PAID);
//       expect(p.providerPaymentId).toBe(`pay_${linkId}`);
//       expect(p.paymentMethod).toBe('gcash');
//       expect(p.paidAt).toBeTruthy();
//       const r = await regRow(reg.id);
//       expect(r.status).toBe(RegistrationStatus.REGISTERED);
//       expect(r.bibNumber).toBeTruthy();

//       // QR becomes available only now (race-pass refuses pending registrations)
//       expect((await registrations.getRacePass(reg.id)).qrToken).toBeTruthy();

//       // audit trail
//       const logs = await ds.getRepository(PaymentStatusLog).find({ where: { paymentId } });
//       expect(logs.map((l) => l.toStatus)).toEqual(['pending', 'paid']);

//       // redelivery of the SAME event id is acknowledged and not re-applied
//       const dup = await deliver(event);
//       expect(dup.json).toMatchObject({ received: true, duplicate: true });
//       // a DIFFERENT event id for the same payment is a no-op too
//       const replay = payOnPayMongo(linkId);
//       links.get(linkId).attributes.payments.pop();
//       expect((await deliver(replay)).status).toBe(200);
//       expect((await ds.getRepository(PaymentStatusLog).find({ where: { paymentId } })).length).toBe(2);
//       expect((await regRow(reg.id)).bibNumber).toBe(r.bibNumber);
//       expect(await ds.getRepository(PaymentWebhookEvent).count({ where: { providerEventId: (event as any).data.id } })).toBe(1);
//     });

//     it('a late/duplicate event can never downgrade a PAID payment', async () => {
//       expect(await settlement.expire(paymentId)).toBe(false);
//       await ds.transaction(async (m) => {
//         const p = await m.findOneOrFail(Payment, { where: { id: paymentId } });
//         const ledger = (settlement as any).ledger;
//         expect(await ledger.transition(m, p, PaymentStatus.CANCELLED, { source: 'api' })).toBe(false);
//         expect(await ledger.transition(m, p, PaymentStatus.FAILED, { source: 'api' })).toBe(false);
//       });
//       expect((await paymentRow(paymentId)).status).toBe(PaymentStatus.PAID);
//     });

//     it('a second runner payment for an already-paid registration is blocked (DB-level guard)', async () => {
//       await expect(ds.getRepository(Payment).save(ds.getRepository(Payment).create({
//         purpose: PaymentPurpose.RUNNER_REGISTRATION, registrationId: reg.id, eventId: openEvent.id,
//         registrationFee: '1.00', platformFee: '0.00', totalAmount: '1.00', amountCentavos: 100,
//         status: PaymentStatus.PAID, paidGuardKey: `reg:${reg.id}`,
//       }))).rejects.toThrow(/Duplicate|UQ_payments_paid_guard/i);
//     });

//     it('amount mismatch is NOT applied and is flagged for reconciliation', async () => {
//       const r2 = await registrations.startRegistration(runner.id, regDto(paidCat.id, 'Maria') as any);
//       const res: any = await payments.createCheckout(r2.id, actor(runner));
//       const lid = (await paymentRow(res.paymentId)).providerCheckoutId;
//       const out = await deliver(payOnPayMongo(lid, 100));
//       expect(out.status).toBe(200);
//       const p = await paymentRow(res.paymentId);
//       expect(p.status).toBe(PaymentStatus.PENDING);
//       expect(p.needsReconciliation).toBeTruthy();
//       expect(p.reconciliationNote).toMatch(/mismatch/i);
//       expect((await regRow(r2.id)).status).toBe(RegistrationStatus.PENDING_PAYMENT);
//     });

//     it('a webhook for an unknown link is acknowledged (200) and recorded as ignored', async () => {
//       links.set('link_ghost', { id: 'link_ghost', type: 'link', attributes: { amount: 100, status: 'unpaid', payments: [] } });
//       expect((await deliver(payOnPayMongo('link_ghost'))).status).toBe(200);
//       const ev = await ds.getRepository(PaymentWebhookEvent).findOne({ where: { eventType: 'link.payment.paid' }, order: { id: 'DESC' } });
//       expect(ev?.status).toBe('ignored');
//     });

//     it('unsupported event types are ignored', async () => {
//       const res = await deliver({ data: { id: `evt_pay_link_other_${uniq}`, attributes: { type: 'payment.refunded', data: {} } } });
//       expect(res.status).toBe(200);
//     });

//     it('settles via a server-side PayMongo lookup when the webhook is missed', async () => {
//       const r3 = await registrations.startRegistration(runner.id, regDto(paidCat.id, 'Pedro') as any);
//       const res: any = await payments.createCheckout(r3.id, actor(runner));
//       const lid = (await paymentRow(res.paymentId)).providerCheckoutId;
//       payOnPayMongo(lid); // paid at PayMongo, but no webhook delivered
//       const status = await payments.getStatusForRegistration(r3.id, actor(runner));
//       expect(status.status).toBe('paid');
//       expect((await regRow(r3.id)).status).toBe(RegistrationStatus.REGISTERED);
//     });

//     it('free registrations skip PayMongo entirely and are confirmed directly', async () => {
//       const before = calls.length;
//       const r = await registrations.startRegistration(runner.id, regDto(freeCat.id, 'Free') as any);
//       const res: any = await payments.createCheckout(r.id, actor(runner));
//       expect(res.free).toBe(true);
//       expect(calls.length).toBe(before);
//       expect((await regRow(r.id)).status).toBe(RegistrationStatus.REGISTERED);
//     });

//     it('resumes (does not duplicate) a pending registration and refuses a paid duplicate', async () => {
//       const a = await registrations.startRegistration(runner.id, regDto(paidCat.id, 'Dup') as any);
//       const b = await registrations.startRegistration(runner.id, regDto(paidCat.id, 'Dup') as any);
//       expect(b.id).toBe(a.id);
//       await expect(registrations.startRegistration(runner.id, regDto(paidCat.id) as any)).rejects.toThrow(/already registered/);
//     });

//     it('expiry releases the slot; a payment arriving afterwards revives the registration', async () => {
//       const r = await registrations.startRegistration(runner.id, regDto(paidCat.id, 'Late') as any);
//       const slotsHeld = await slots(paidCat.id);
//       const res: any = await payments.createCheckout(r.id, actor(runner));
//       const lid = (await paymentRow(res.paymentId)).providerCheckoutId;

//       expect(await settlement.expire(res.paymentId)).toBe(true);
//       expect((await paymentRow(res.paymentId)).status).toBe(PaymentStatus.EXPIRED);
//       expect((await regRow(r.id)).status).toBe(RegistrationStatus.CANCELLED);
//       expect(await slots(paidCat.id)).toBe(slotsHeld + 1);
//       expect(links.get(lid).attributes.archived).toBe(true);

//       await deliver(payOnPayMongo(lid)); // money arrives on the expired link anyway
//       expect((await paymentRow(res.paymentId)).status).toBe(PaymentStatus.PAID);
//       expect((await regRow(r.id)).status).toBe(RegistrationStatus.REGISTERED);
//       expect(await slots(paidCat.id)).toBe(slotsHeld);
//     });

//     it('PayMongo failure leaves no orphan pending payment', async () => {
//       const r = await registrations.startRegistration(runner.id, regDto(paidCat.id, 'Fail') as any);
//       failNextCreate = true;
//       await expect(payments.createCheckout(r.id, actor(runner))).rejects.toThrow(/rejected/);
//       expect(await ds.getRepository(Payment).count({ where: { registrationId: r.id } })).toBe(0);
//     });

//     it('draft events cannot take registrations', async () => {
//       const cat = (await ds.getRepository(EventCategory).findOneOrFail({ where: { eventId: draftEvent.id } }));
//       await expect(registrations.startRegistration(runner.id, regDto(cat.id, 'Nope') as any)).rejects.toThrow(/not open/);
//     });

//     it('guest group: ONE link for the group, status by group id, confirms everyone', async () => {
//       const guestBatch = await registrations.createGuestBatch({
//         contactEmail: `guest.${uniq}@it.test`, contactFirstName: 'G', contactLastName: 'One',
//         participants: [regDto(paidCat.id, 'G1'), regDto(paidCat.id, 'G2')] as any,
//       } as any);
//       const groupId = guestBatch[0].groupId!;
//       const res: any = await payments.createGroupCheckout(groupId);
//       expect(res.amountCentavos).toBe(100_000); // 2 x 500, fee computed once on the total
//       const again: any = await payments.createGroupCheckout(groupId);
//       expect(again.reused).toBe(true);

//       expect((await payments.getGroupStatus(groupId)).status).toBe('pending');
//       await expect(payments.getGroupStatus('not-a-real-group')).rejects.toThrow();

//       await deliver(payOnPayMongo((await paymentRow(res.paymentId)).providerCheckoutId));
//       const st = await payments.getGroupStatus(groupId);
//       expect(st.status).toBe('paid');
//       expect(st.registrations.every((x) => x.status === RegistrationStatus.REGISTERED)).toBe(true);
//       expect(JSON.stringify(st)).not.toMatch(/webhook|providerCheckout|pay_/);
//       const guestId = guestBatch[0].runnerUserId;
//       created.users.push(guestId);
//     });
//   });

//   // ======================== Flow B: organizer platform fee =====================================
//   describe('Flow B — organizer event fee', () => {
//     let paymentId: string;
//     let linkId: string;

//     it('with no fee configured, publishing works exactly as before', async () => {
//       const ev = await mkEvent(EventStatus.DRAFT, `NoFee ${uniq}`);
//       await mkCat(ev, '100.00');
//       const st = await orgPayments.getStatus(ev.id, organizer.id);
//       expect(st).toMatchObject({ required: false, feeStatus: 'not_required', canPublish: true });
//       await expect(orgPayments.createPaymentLink(ev.id, organizer.id)).rejects.toThrow(/No platform fee/);
//       expect((await events.publish(ev.id)).status).toBe(EventStatus.REG_OPEN);
//     });

//     it('the backend decides the fee; the quote comes from the admin-managed config', async () => {
//       await fees.setFee({ amountPesos: 499, description: 'Event publishing fee' }, admin.id);
//       expect(await orgPayments.getQuote()).toMatchObject({ required: true, amountCentavos: 49_900, amount: '499.00', currency: 'PHP' });
//     });

//     it('publishing is blocked (402) until the fee is paid', async () => {
//       await expect(events.publish(draftEvent.id)).rejects.toMatchObject({ status: 402 });
//       expect((await orgPayments.getStatus(draftEvent.id, organizer.id)).feeStatus).toBe('unpaid');
//     });

//     it('only the owning organizer can use the fee endpoints', async () => {
//       await expect(orgPayments.createPaymentLink(draftEvent.id, otherOrganizer.id)).rejects.toThrow('Event not found');
//       await expect(orgPayments.getStatus(draftEvent.id, otherOrganizer.id)).rejects.toThrow('Event not found');
//     });

//     it('will not take payment for an event that could not be published anyway', async () => {
//       const bare = await mkEvent(EventStatus.DRAFT, `Bare ${uniq}`);
//       await expect(orgPayments.createPaymentLink(bare.id, organizer.id)).rejects.toThrow(/category/);
//     });

//     it('creates one payment link, snapshotting the charged amount; retries reuse it', async () => {
//       const st = await orgPayments.createPaymentLink(draftEvent.id, organizer.id);
//       expect(st.feeStatus).toBe('pending');
//       expect(st.payment!.checkoutUrl).toMatch(/pm\.link/);
//       paymentId = st.payment!.id;
//       const again = await orgPayments.createPaymentLink(draftEvent.id, organizer.id);
//       expect(again.payment!.id).toBe(paymentId);
//       expect(await ds.getRepository(Payment).count({ where: { eventId: draftEvent.id, purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION } })).toBe(1);

//       const row = await paymentRow(paymentId);
//       expect(row).toMatchObject({ purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION, registrationId: null, amountCentavos: 49_900, ownerUserId: organizer.id, organizationId: org.id });
//       linkId = row.providerCheckoutId;
//       // still blocked while merely pending
//       await expect(events.publish(draftEvent.id)).rejects.toMatchObject({ status: 402 });
//     });

//     it('a paid webhook marks the FEE paid but does not publish the event', async () => {
//       expect((await deliver(payOnPayMongo(linkId))).status).toBe(200);
//       expect((await paymentRow(paymentId)).status).toBe(PaymentStatus.PAID);
//       expect((await ds.getRepository(Event).findOneOrFail({ where: { id: draftEvent.id } })).status).toBe(EventStatus.DRAFT);
//       const st = await orgPayments.getStatus(draftEvent.id, organizer.id);
//       expect(st).toMatchObject({ feeStatus: 'paid', canPublish: true });
//       expect(st.fee!.amount).toBe('499.00');
//     });

//     it('publishing now succeeds, via the existing publish flow', async () => {
//       expect((await events.publish(draftEvent.id)).status).toBe(EventStatus.REG_OPEN);
//     });

//     it('changing the fee later does not rewrite history or re-charge a paid event', async () => {
//       await fees.setFee({ amountPesos: 999 }, admin.id);
//       const st = await orgPayments.getStatus(draftEvent.id, organizer.id);
//       expect(st.fee!.amountCentavos).toBe(49_900);
//       expect(st.feeStatus).toBe('paid');
//       await expect(orgPayments.createPaymentLink(draftEvent.id, organizer.id)).rejects.toThrow(/Only draft/);
//       await fees.setFee({ amountPesos: 499 }, admin.id);
//     });

//     it('purposes are independent: organizer events never appear as runner revenue', async () => {
//       const runnerRows = await payments.getTransactionsForAdmin({});
//       expect(runnerRows.every((p) => p.purpose === PaymentPurpose.RUNNER_REGISTRATION)).toBe(true);
//       const orgRows = await payments.getTransactionsForAdmin({ purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION });
//       expect(orgRows.some((p) => p.id === paymentId)).toBe(true);
//       expect(orgRows.every((p) => p.purpose === PaymentPurpose.ORGANIZER_EVENT_CREATION)).toBe(true);
//     });

//     it('an expired link can be retried; the old one is archived; a late payment on it is flagged, not double-applied', async () => {
//       const ev = await mkEvent(EventStatus.DRAFT, `Retry ${uniq}`);
//       await mkCat(ev, '100.00');
//       const first = await orgPayments.createPaymentLink(ev.id, organizer.id);
//       const firstId = first.payment!.id;
//       const firstLink = (await paymentRow(firstId)).providerCheckoutId;

//       await ds.getRepository(Payment).update(firstId, { expiresAt: new Date(Date.now() - 1000) });
//       expect((await orgPayments.getStatus(ev.id, organizer.id)).feeStatus).toBe('expired');
//       expect(links.get(firstLink).attributes.archived).toBe(true);

//       const second = await orgPayments.createPaymentLink(ev.id, organizer.id);
//       expect(second.payment!.id).not.toBe(firstId);
//       const secondLink = (await paymentRow(second.payment!.id)).providerCheckoutId;

//       await deliver(payOnPayMongo(secondLink));
//       expect((await orgPayments.getStatus(ev.id, organizer.id)).feeStatus).toBe('paid');

//       // The expired attempt's link is paid too (e.g. archived too late): money is flagged, never a 2nd PAID.
//       await deliver(payOnPayMongo(firstLink));
//       const dupe = await paymentRow(firstId);
//       expect(dupe.status).not.toBe(PaymentStatus.PAID);
//       expect(dupe.needsReconciliation).toBeTruthy();
//       expect(dupe.reconciliationNote).toMatch(/already paid|Duplicate/i);
//       expect(await ds.getRepository(Payment).count({ where: { eventId: ev.id, status: PaymentStatus.PAID } })).toBe(1);
//       const queue = await payments.getReconciliationQueue();
//       expect(queue.some((p) => p.id === firstId)).toBe(true);
//     });

//     it('a runner payment can never satisfy an organizer fee (and vice versa)', async () => {
//       const ev = await mkEvent(EventStatus.DRAFT, `Cross ${uniq}`);
//       await mkCat(ev, '100.00');
//       await expect(events.publish(ev.id)).rejects.toMatchObject({ status: 402 });
//       // runner payments exist for other events; none of them satisfies this event's fee
//       expect(await fees.findPaidFee(ev.id)).toBeNull();
//     });
//   });
// });
