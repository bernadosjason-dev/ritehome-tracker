// Phase 5a, Company profile (supabase/migrations/20261123000020_company_profile.sql) on a real local
// PostgreSQL: the bookkeeper edits the profile and the document register, the admin also removes
// (archives) documents, nobody else sees any of it, and files go only where the bucket rules allow.
//   node --test tests/company.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const DOC = 'documents/0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d.pdf';
const DOC2 = 'documents/1c7d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e.jpg';
const get = (who) => JSON.parse(db.must(who, `select public.company_get()`));

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'),
    ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}'), ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}'),
    ('${U.inactive}', 'old@example.com', '{"full_name":"Old"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';
    update public.profiles set role = 'purchaser', active = true, full_name = 'Pia' where id = '${U.purchaser}';
    update public.profiles set role = 'bookkeeper', active = false, full_name = 'Old' where id = '${U.inactive}';`);
});
test.after(() => db && db.stop());

test('the bookkeeper edits the profile; blank authorised rows are dropped; bad details are refused', () => {
  const { must, refused } = db;
  assert.equal(get('book').profile.legal_name, 'Ritehome Modular Systems');
  must('book', `select public.company_profile_save(${j({ address: 'Cagayan de Oro City', phones: '0917 000 0000', email: 'hello@example.com',
    tin: '000-000-000-000', business_type: 'sole_proprietorship', vat_registered: 'false',
    authorized: [{ name: 'Owner Name', position: 'Proprietor' }, { name: '  ', position: 'blank row' }] })})`);
  const p = get('book').profile;
  assert.equal(p.address, 'Cagayan de Oro City'); assert.equal(p.vat_registered, false); assert.equal(p.updated_by_name, 'Bea');
  assert.deepEqual(p.authorized, [{ name: 'Owner Name', position: 'Proprietor', phone: '', email: '' }]);
  assert.equal(p.legal_name, 'Ritehome Modular Systems', 'fields not sent stay as they were');
  refused('book', `select public.company_profile_save(${j({ email: 'not an email' })})`, /check constraint/);
  refused('book', `select public.company_profile_save(${j({ website: 'ritehome.ph' })})`, /check constraint/);
  refused('book', `select public.company_profile_save(${j({ business_type: 'cooperative' })})`, /check constraint/);
  refused('book', `select public.company_profile_save(${j({ authorized: Array.from({ length: 11 }, (_, i) => ({ name: 'P' + i })) })})`, /at most 10/);
  refused('book', `select public.company_profile_save(${j({ logo_path: 'logo/../../etc.png' })})`, /check constraint/);
  refused('book', `update public.company_profile set legal_name = 'x'`, /permission denied/);
});

test('nobody else sees or edits the company profile (the permission matrix: admin and bookkeeper only)', () => {
  const { must, refused } = db;
  for (const who of ['designer', 'sales', 'purchaser', 'inactive']) {
    refused(who, `select public.company_get()`, /admin and the bookkeeper/);
    refused(who, `select public.company_profile_save(${j({ address: 'x' })})`, /admin and the bookkeeper/);
    assert.equal(must(who, `select count(*) from public.company_profile`), '0', who + ' reads no profile row');
  }
  refused('anon', `select public.company_get()`, /permission denied/);
  assert.equal(get('admin').profile.address, 'Cagayan de Oro City');
});

test('files: only the admin and bookkeeper upload, only to logo/ and documents/ with a safe name; nothing is overwritten or deleted', () => {
  const { must, refused } = db;
  must('book', `insert into storage.objects (bucket_id, name) values ('company-files', '${DOC}')`);
  refused('designer', `insert into storage.objects (bucket_id, name) values ('company-files', '${DOC2}')`, /row-level security/);
  refused('book', `insert into storage.objects (bucket_id, name) values ('company-files', 'documents/permit.svg')`, /row-level security/);
  refused('book', `insert into storage.objects (bucket_id, name) values ('company-files', 'other/0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d.pdf')`, /row-level security/);
  assert.equal(must('book', `select count(*) from storage.objects where bucket_id = 'company-files'`), '1');
  assert.equal(must('designer', `select count(*) from storage.objects where bucket_id = 'company-files'`), '0');
  assert.equal(must('book', `with d as (delete from storage.objects where bucket_id = 'company-files' returning 1) select count(*) from d`), '0', 'no delete');
  assert.equal(must('admin', `with d as (delete from storage.objects where bucket_id = 'company-files' returning 1) select count(*) from d`), '0', 'not even the admin');
  const b = must('super', `select file_size_limit || '|' || array_to_string(allowed_mime_types, ',') || '|' || public from storage.buckets where id = 'company-files'`);
  assert.equal(b, '10485760|application/pdf,image/png,image/jpeg,image/webp|false');
});

test('the document register: a file must have arrived, expiry is counted in Manila days, only the admin removes (archives)', () => {
  const { must, refused, U } = db;
  refused('book', `select public.company_document_save(${j({ title: 'Mayor\'s permit 2026', kind: 'mayors_permit', file_path: DOC2 })})`, /didn't arrive/);
  const today = must('super', `select (now() at time zone 'Asia/Manila')::date`);
  const d = JSON.parse(must('book', `select public.company_document_save(${j({ title: "Mayor's permit 2026", kind: 'mayors_permit', file_path: DOC,
    file_name: 'permit.pdf', size_bytes: 120000, expires_on: today })})`));
  refused('book', `select public.company_document_save(${j({ title: 'Again', file_path: DOC })})`, /duplicate key|unique/);
  refused('book', `select public.company_document_save(${j({ title: 'x', kind: 'tax_haven', file_path: DOC })})`, /check constraint/);
  must('book', `select public.company_document_save(${j({ id: d.id, expires_on: '2026-12-31', notes: 'Renew in December' })})`);
  const doc = get('book').documents[0];
  assert.equal(doc.expires_on, '2026-12-31'); assert.equal(doc.uploader, 'Bea'); assert.equal(doc.notes, 'Renew in December');
  assert.equal(doc.days_left, Number(must('super', `select date '2026-12-31' - (now() at time zone 'Asia/Manila')::date`)));
  refused('designer', `select public.company_document_save(${j({ id: d.id, title: 'x' })})`, /admin and the bookkeeper/);
  refused('book', `select public.company_document_archive('${d.id}')`, /Only the admin removes/);
  assert.equal(get('book').can_archive, false); assert.equal(get('admin').can_archive, true);
  must('admin', `select public.company_document_archive('${d.id}')`);
  assert.equal(get('book').documents.length, 0, 'out of the list');
  assert.equal(must('super', `select archived_by from public.company_documents where id = '${d.id}'`), U.admin, 'kept, with who removed it');
  refused('admin', `select public.company_document_archive('${d.id}')`, /isn't in the register/);
  refused('book', `select public.company_document_save(${j({ id: d.id, title: 'back' })})`, /isn't in the register/);
});

test('the dashboard counts expired and soon-expiring documents; every change is in the activity log under Company', () => {
  const { must } = db;
  must('book', `insert into storage.objects (bucket_id, name) values ('company-files', '${DOC2}')`);
  must('book', `select public.company_document_save(${j({ title: 'BIR 2303', kind: 'bir', file_path: DOC2,
    expires_on: must('super', `select ((now() at time zone 'Asia/Manila')::date - 1)::text`) })})`);
  const o = JSON.parse(must('admin', `select public.dashboard_overview()`)).company;
  assert.equal(o.expired, 1); assert.equal(o.expiring, 0); assert.equal(o.next.title, 'BIR 2303');
  assert(Number(must('super', `select count(*) from public.audit_log where module = 'Company' and table_name = 'company_profile'`)) >= 1);
  assert(Number(must('super', `select count(*) from public.audit_log where module = 'Company' and table_name = 'company_documents' and action = 'update' and 'archived_at' = any (changed)`)) === 1);
  assert(Number(must('super', `select count(*) from public.notify_events where module = 'Company'`)) >= 1, 'the admin hears about the bookkeeper\'s changes');
});
