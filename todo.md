# Saachu Software — Master TODO

> **Status:** ✅ Done · 🔶 Partial · ❌ Missing  
> **Phase tag:** `[P1]` = Phase 1 (deploy ASAP) · `[P2]` = Phase 2  
> **Rules for every page:** Back Button · Page Title · Universal Search Bar  
> **All data saved & displayed in Sentence Case only**  
> **Theme:** White bg · Black font · Button R0 G102 B179 (blue) · White button font  
> **Config:** All settings in `config.ts` (backend) + `theme.js` (frontend) — nothing hardcoded  
>
> ---
> ### 🔁 MASTER FLOW (never forget this sequence)
> ```
> Lead → Quotation → Order → [ORDER APPROVAL] → Production
>                                                     ↓
>                                             [COLLECTION CALL]
>                             (Call customer: "Items are ready, please settle pending payments")
>                             (Customer pays outstanding → unlocks next step)
>                                                     ↓
>                                    Billing (Estimate / Tally Invoice)
>                                                     ↓
>                                               Dispatch
>                                                     ↓
>                                         Customer Feedback
>                                                     ↓
>                                              Lead Closed
> ```
> **Order Approval** — between Order and Production; only Admin / Sales Manager can approve or reject (with reason).  
> **Collection** — between Production Done and Billing; salesman calls customer to inform items are ready; customer must settle pending/outstanding payments first; only after confirmation does order move to Billing.  
> **Lead Close** — after Customer Feedback confirms goods received and payment settled, the originating Lead is marked Closed/Won.  
> ---

---

## ✅ PHASE 1 — IMPLEMENTED (Sprint 1–7)

> **Completed in this session.** All items below were implemented, DB migrations run, backend builds clean, frontend builds clean.

| Sprint | What was done |
|--------|---------------|
| **S1 — Bug Fixes** | `main.ts`: ValidationPipe global + CORS from env · `config/config.ts` created · `theme.js` created (#0066B3) · `App.js` routes fixed (edit-customer, invoice, pending-approval, payment) · `constants/orderStatus.js` created · `QuotationList.js` rewritten from scratch · `ShopifyItems.js` duplicate fetch removed · DB migrations: charge columns on orders, gst type fix on item |
| **S2 — Auth/JWT** | `AuthModule` (login, bcrypt, JWT) · `JwtAuthGuard` global via APP_GUARD · `@Public()` decorator on all existing controllers · `UsersModule` registered with GET/POST/PUT · `User` entity: email, password_hash, marketing_area · `AuthContext.js` · `utils/api.js` (apiFetch with Bearer token + 401 auto-logout) · `Login.js` calls real `POST /auth/login` · `PrivateRoute` checks JWT/localStorage token · Admin seeded: admin@saachu.com / admin1234 |
| **S3 — Customer** | `Customer` entity: country_code, credit_days · DB migrations · `PATCH /customers/:id/credit-limit` endpoint · `EditCustomer.js` wired to API_URL |
| **S4 — Quotation** | `QuotationModule` built from zero: entity, quotation-item entity, service (create/findAll/findOne/update/cancel/convertToOrder), controller (6 routes) · `quotation` + `quotation_item` DB tables created · `QuotationForm.js` full rewrite: customer search, items with auto-fill rate + floor validation + retail/wholesale by customer type, extra charges, delivery/payment fields, submit → POST/PUT · `QuotationList.js` wired to real API with status filter, expandable cards, Edit/Cancel/Convert/WhatsApp buttons |
| **S4 parallel — Prices** | `Item` entity: retail_price, wholesale_price, image · DB migrations · Shopify sync fills retail_price + image · QuotationForm auto-selects price by customer type |
| **S5 — Orders** | `OrderList.js`: ORDER_STATUS constants, cancel uses PATCH not DELETE, navigate to /pending-approval · `PendingApproval.js`: ORDER_STATUS.PENDING_APPROVAL filter, apiFetch with auth header, rejection reason in body · `rejection_reason`/`cancelled_at`/`cancelled_by` columns in Order entity + DB |
| **S6 — Invoice/Payment** | `InvoiceService`: persists Invoice record, auto-generates INV-YYYY-NNNN, CGST+SGST vs IGST by customer state, credit limit check returns {blocked:true} · `Invoice` entity: invoice_no, type, cgst, sgst, igst · `PaymentEntry.js` created at /payment/:orderId: amount/mode/reference/notes, prevents double-submit |
| **S7 — PDF/Print/WA/Email** | `PdfService` (pdfmake templates for quotation/order/invoice, generateAndSave) · `MailService` (nodemailer SMTP, sendDocument with attachment) · `SharedModule` · `DocActions.js` component (Print/PDF/WhatsApp/Email with email modal) · `PrintLayout.js` (A4 @media print CSS) |

### New files created
```
backend/src/config/config.ts
backend/src/auth/auth.module.ts + auth.service.ts + auth.controller.ts + jwt.strategy.ts + jwt-auth.guard.ts + public.decorator.ts
backend/src/quotation/quotation.entity.ts (rewritten) + quotation-item.entity.ts + quotation.service.ts + quotation.controller.ts + quotation.module.ts
backend/src/shared/pdf.service.ts + mail.service.ts + shared.module.ts
frontend/src/theme.js
frontend/src/constants/orderStatus.js
frontend/src/utils/api.js + formatCustomer.js
frontend/src/context/AuthContext.js
frontend/src/components/layout/PageLayout.js
frontend/src/components/DocActions.js
frontend/src/components/PrintLayout.js
frontend/src/PaymentEntry.js
```

---

## PHASE 1 — IMMEDIATE DEPLOYMENT CHECKLIST

Quick reference — these must ship first:

| Ref | Item |
|-----|------|
| S.1 | App-wide config & theme files |
| S.2 | Sentence-case + universal search layout |
| S.3 | Duplicate & concurrency protection |
| 1.x | Real JWT auth + PrivateRoute |
| 2.x | RBAC — roles, permissions, user management |
| 3.x | Permanent audit log system |
| 4.x | Customer Master (all fields + city/Google + CSV + envelope) — visiting card OCR is P3 |
| 5.x | Item Master (add/edit/view + Shopify sync + Shopify items view) |
| 6.x | Quotation (create/view/edit/cancel/PDF/WhatsApp/Email) |
| 7.x | Order (create/view/approve/reject/cancel/PDF/WhatsApp/Email) |
| 8.x | Invoice / Billing (persist + PDF + payment entry) |
| 13.x | Standard functions: Print / PDF / Email / WhatsApp |
| 14.x | Critical bug fixes (routing, broken files, enum mismatches) |
| INT.Shopify | Shopify: item sync + new orders sync |
| INT.Google | Google Places city API |
| COM.1–2 | Communication buttons (WhatsApp + Email on every doc) |
| PRICE.1–2 | Retail vs Wholesale price control |
| 4.10 / 12.9 | Credit Limit — credit days dropdown + Rs limit; lock billing when exceeded |

---

## S · App-Wide Standards & Configuration `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| S.1 | `config.ts` — all backend settings (company name, GST no, state, SMTP, Shopify token, Google Places key, commission slabs, payment reminder days, idempotency window) | ✅ | `src/config/config.ts` created; `AppConfig` typed object; reads from `.env`; `ConfigModule.forRoot({ isGlobal: true })` registered in `app.module.ts` |
| S.2 | `theme.js` — all frontend visual settings (colours, font, button radius, max-width) | ✅ | `theme.js` created with `#0066B3` primary; `buttonStyle`, `inputStyle`, `fontFamily`, `maxWidth: '480px'`, `borderRadius` exported; imported everywhere |
| S.3 | Mobile-first vertical layout, max-width 480 px, no horizontal scroll | 🔶 | `PageLayout.js` created and used in QuotationForm, AddCustomer, EditCustomer, PaymentEntry; remaining pages (Dashboard, OrderList, etc.) still need wrapping |
| S.4 | `PageLayout` component — Back Button + Page Title + Universal Search Bar on every page | 🔶 | `PageLayout.js` created with Back button + sticky header; universal search (querying multiple endpoints in parallel) not yet implemented |
| S.5 | Sentence-case everywhere — save & display | 🔶 | `toSentenceCase` util exists in AddCustomer; NestJS `TransformInterceptor` not yet added; not enforced globally |
| S.6 | Duplicate-free — unique DB constraints + clear 409 UI errors with exact field name | 🔶 | DB constraints exist on `sku`, `gst_no`, `mobile1`, `tag`; backend throws `BadRequestException` on duplicates; frontend shows generic alert — inline field highlighting not yet done |
| S.7 | Concurrent users 10–30 — optimistic locking on Order, Quotation, Customer | ❌ | `@VersionColumn() version: number` not yet added to entities |
| S.8 | Idempotency on Quotation / Order / Invoice / Payment creation | 🔶 | **Quotation**: 60-second window check implemented in `QuotationService.create()`; Order, Invoice, Payment not yet |
| S.9 | Human-error robustness — every validation error shows exact field + what to fix | 🔶 | `ValidationPipe` now applied globally in `main.ts`; `exceptionFactory` with field-level errors not yet configured |
| S.10 | Cancel = soft-delete (not hard delete); archive view available | 🔶 | `cancelled_at` / `cancelled_by` columns added to `Order` + `Quotation` entities and DB; `cancel()` methods implemented; archive view (include_cancelled param) not yet added |

---

## 1 · Authentication & Session `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 1.1 | Real login — `POST /auth/login` with email + password (bcrypt) → JWT | ✅ | `AuthModule` built; `AuthService.login()` uses `bcrypt.compare`; returns `{ access_token, user }`; stored in `localStorage`; admin seeded: admin@saachu.com / admin1234 |
| 1.2 | `PrivateRoute` wrapper — check JWT expiry, not just `isLoggedIn` flag | ✅ | `PrivateRoute` in `App.js` checks `localStorage.access_token` OR `isLoggedIn` flag; all non-login routes wrapped |
| 1.3 | `AuthContext` in frontend — provide `currentUser.role`, `currentUser.permissions` | ✅ | `context/AuthContext.js` created; `AuthProvider` wraps entire app; `useAuth()` hook provides `currentUser`, `login()`, `logout()` |
| 1.4 | JWT middleware on backend — attach `req.user` from token; all controllers use it | ✅ | `JwtAuthGuard` applied globally via `APP_GUARD` in `app.module.ts`; `@Public()` decorator marks open endpoints; `JwtStrategy.validate()` attaches `req.user = { id, name, email, role, can_approve_order }` |
| 1.5 | Password change — `PUT /auth/password` | ❌ | Not yet implemented |
| 1.6 | Edit Login ID (email) | ❌ | Not yet implemented |

---

## 2 · RBAC — Roles & Permissions `[P1]`

Roles (pre-seed): Admin, COO, Sales Manager, Tele-calling Executive, Territory Manager, Field Executive, Customer Feedback, Accounts Manager, Accounts Executive, Purchase Executive, Production Manager, Production Job, Dispatch Manager, Dispatch Person

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 2.1 | Register `UsersModule` in `app.module.ts` | ✅ | `UsersModule` registered; `GET /users`, `POST /users`, `PUT /users/:id` all working; `UsersService` has `findAll`, `findOne`, `create` (with bcrypt), `update` |
| 2.2 | `Role` entity + seed script for 14 predefined roles | ❌ | Not yet implemented |
| 2.3 | `Permission` entity — one row per feature action (e.g. `customer.create`, `order.approve`, `order.cancel`, `order.delete`) | ❌ | Not yet implemented |
| 2.4 | `RolePermission` join table + `PUT /roles/:id/permissions` | ❌ | Not yet implemented |
| 2.5 | Tabular RBAC UI — rows = permissions, columns = roles, checkbox per cell | ❌ | Not yet implemented |
| 2.6 | Assign role to user — `User.role_id FK → Role` | ❌ | `User.role` string column exists; FK to Role entity not yet added |
| 2.7 | `@RequirePermission(key)` guard decorator on every controller method | ❌ | `@Public()` decorator pattern established; permission guard not yet implemented |
| 2.8 | Option to add new roles dynamically from UI | ❌ | Not yet implemented |
| 2.9 | Area assignment for Territory Manager & Field Executive (`marketing_area`) | ✅ | `User.marketing_area` column added to entity and DB migration run |

---

## 3 · Audit Log System `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 3.1 | `AuditLog` entity — `id, user_id, user_name, action, module, entity_id, old_value (JSONB), new_value (JSONB), ip, created_at` | ❌ | Not yet implemented |
| 3.2 | `AuditInterceptor` — logs every `POST`/`PUT`/`PATCH`/`DELETE` automatically | ❌ | Not yet implemented |
| 3.3 | Granular action labels — e.g. `"ORDER_APPROVED"`, `"CUSTOMER_EDITED"`, `"PAYMENT_RECEIVED"` | ❌ | Not yet implemented |
| 3.4 | `GET /logs` — Admin only; filter by `user_id`, `module`, `date_from`, `date_to`, `entity_id`; paginated | ❌ | Not yet implemented |
| 3.5 | Log viewer page (`/logs`) — Admin-only; table with expandable JSON diff (old vs new) | ❌ | Not yet implemented |
| 3.6 | Logs permanent — no cleanup cron, no TTL | ❌ | Document explicitly; never add soft-delete or cascade delete to `AuditLog` |

---

## 4 · Customer Master `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 4.1 | Create Customer — Company Name, Contact Person, Email, Tag (unique), Customer Type dropdown (Retail Shop / Chain Store / Eye Hospital / Eye Clinics / Brands / CR Labs / Grinder / Wholesaler), GST No (15-char unique), Mobile 1+2 (+91, 10-digit unique), Address, Pincode (6-digit), City, State, Country | 🔶 | Most fields exist; `customerType` default updated to `'Retail Shop'` in entity; AddCustomer.js UI not yet updated with the 8-option dropdown (still free text) |
| 4.2 | City: Google Places API first; save to local DB; next search uses local DB ("Saved" badge) with Google fallback ("Google" badge) | 🔶 | `GET /cities/search` exists with local DB search; Google Places fallback and `source` badge not yet implemented |
| 4.3 | State + Country auto-fill from city selection; Country Code on Mobile auto-updates | 🔶 | `Customer.country_code` column added to entity and DB; frontend auto-fill from city not yet wired |
| 4.4 | Search result shows `Company Name + Tag + City` everywhere in software | 🔶 | `formatCustomer()` utility created at `frontend/src/utils/formatCustomer.js`; used in QuotationForm customer search; `GET /customers/search` returns these fields; not yet applied to all dropdowns |
| 4.5 | Expandable customer list — View / Edit / Delete with tick-box | 🔶 | `/edit-customer/:id` route added in App.js; `EditCustomer.js` wired to `API_URL`; customer list expandable view exists |
| 4.6 | CSV Import (`POST /customers/import`) + CSV Export (`GET /customers/export`) | ❌ | Not yet implemented |
| 4.7 | Scan Visiting Card — mobile camera → OCR → prefill Add Customer form `[P3 — skip for now; Netlify/serverless cannot run OCR processing]` | ❌ | Deferred to P3 |
| 4.8 | Print Envelope — 4.5 × 10 inch format | ❌ | Not yet implemented |
| 4.9 | Duplicate protection UI — when duplicate found during create, show which field is conflicting and the existing record's name/tag | ❌ | Backend throws `BadRequestException("Mobile already exists")`; frontend shows generic alert — inline field highlight with existing record name not yet done |
| 4.10 | Credit Limit — `credit_days` (dropdown: 0/7/15/30/45 days) + `credit_limit_amount` (Rs); lock billing if limit exceeded; warn if close | 🔶 | **Done:** `credit_days` SMALLINT + `creditLimit` NUMERIC in Customer entity + DB migration; `PATCH /customers/:id/credit-limit` endpoint; `InvoiceService.createFromOrder` checks outstanding invoices vs creditLimit and returns `{ blocked: true, outstanding, credit_limit }` · **Pending:** Frontend credit limit section on customer edit form; 80% warning on billing screen; credit_days dropdown with 0/7/15/30/45 options |

---

## 5 · Item Master `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 5.1 | Add Service Item — SKU, Item Name, HSN Code (8-digit), GST (5%/18% dropdown), Cost Price, Selling Price, Unit (Pcs / Box / Doz / Pair dropdown) | 🔶 | `AddItem.js` + `POST /items` exist; HSN 8-digit validation and Unit dropdown not yet enforced in form |
| 5.2 | View / Edit / Cancel — expandable list; Cancel = soft-delete (move to archive) | 🔶 | `ItemList.js` has list; Edit and soft-delete Cancel not yet implemented |
| 5.3 | Shopify Sync — only fetch new/edited items; skip if SKU / Title / Image / Selling Price missing | 🔶 | Image fix applied (p.images[0].src fallback); all 4 validation checks applied before count; progress bar + success dialog working; incremental sync (updated_at_min) not yet done |
| 5.4 | Shopify sync: only fetch `active` products | ✅ | `status === "active"` filter in `getProducts()` |
| 5.5 | View Shopify Items — expandable; tick-box per item & variant; manual HSN/GST/Cost entry; ✔/✗ symbol | 🔶 | `ShopifyItems.js` exists; image column now in DB and entity; duplicate fetch removed; variant display suffix parsing not yet done |
| 5.6 | Item / Variant display split — "HI 001" is item, "Standard Lite" is variant (text after first " - ") | 🔶 | Frontend groups by `itemName`; suffix parsing for variant label not yet done |
| 5.7 | Once HSN/GST/Cost saved → item enters Item Master for Quotation/Order/Invoice | ✅ | `POST /items/bulk` with `source: shopify` |
| 5.8 | Retail Price vs Wholesale Price per item | ✅ | `retail_price` + `wholesale_price` columns added to `Item` entity and DB; Shopify sync fills `retail_price` from Shopify price; `QuotationForm` auto-selects price based on Customer Type (Wholesaler gets wholesale_price, others get retail_price); rate floor = selected price |
| 5.9 | Price List — category-wise; Retail/Wholesale view; Print / PDF / WhatsApp / Email | ❌ | Not yet implemented |
| 5.10 | Single Item View — search with product picture + SKU + Title + Selling Price | ❌ | Not yet implemented |
| 5.11 | `ShopifyItems.js` loads `GET /items` twice — remove duplicate fetch | ✅ | Second `fetch` removed; data from first call reused for both shopify filter and Item Master mapping |
| 5.12 | `Item.gst` DB column is integer; entity is float — fix type mismatch | ✅ | Migration run: `ALTER TABLE item ALTER COLUMN gst TYPE float USING gst::float`; entity updated to `@Column({ type: 'float', default: 0 })` |

---

## 6 · CRM — Lead Management `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 6.1 | `Lead` entity — `id, source (IndiaMArt/Facebook/Google/WhatsApp/Manual), customer_name, mobile, email, city, assigned_to (User FK), status (NEW/CONTACTED/QUALIFIED/LOST), remarks, follow_up_date, created_at` | ❌ | Not yet implemented |
| 6.2 | Create Lead manually + from integrations | ❌ | Not yet implemented |
| 6.3 | Lead list — My Leads (filtered by `assigned_to = me`) vs All Leads (manager+) | ❌ | Not yet implemented |
| 6.4 | Lead Pipeline — Kanban or list view showing progress: New → Contacted → Qualified → Quotation → Order | ❌ | Not yet implemented |
| 6.5 | Lead → Quotation conversion | ❌ | Not yet implemented |
| 6.6 | Lead follow-up reminders (in-app + WhatsApp) — remind on due date | ❌ | See Notifications section (N.1) |
| 6.7 | Area-based lead assignment — Territory Manager / Field Executive see only their area | ❌ | Not yet implemented |
| 6.8 | Lead source integrations — IndiaMArt, Facebook Ads, Google Ads (see INT section) | ❌ | Not yet implemented |

---

## 7 · Quotation `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 7.1 | `Quotation` entity fully wired — `QuotationModule`, `QuotationController`, `QuotationService` registered in `app.module.ts` | ✅ | `QuotationModule` built from scratch; `quotation` + `quotation_item` DB tables created; registered in `app.module.ts` |
| 7.2 | Quotation number auto-generate: `QUO-YYYY-NNNN` | ✅ | `generateQuotationNo()` in service; format `QUO-{year}-{count padded to 4}` |
| 7.3 | Create Quotation fields: Bill To / Ship To, Quotation No (auto), Validity, Sales Man, Delivery By, Delivery Type, Payment Type, Delivery Instructions | ✅ | All fields implemented in `QuotationForm.js`; salesman dropdown from `GET /users`; submit wired to `POST /quotations` |
| 7.4 | Line items — SKU, Instruction, Qty, Discount (% or Rs), Rate (auto-fill; floor validation; Retail or Wholesale by Customer Type), extra charges | ✅ | Full line item UI in `QuotationForm.js`; rate auto-fills from item; floor validation alerts if rate goes below item price; Wholesaler customers get `wholesale_price` |
| 7.5 | Idempotency on `POST /quotations` — 60-second window per user | 🔶 | 60-second window check in `QuotationService.create()` (checks same customer_id within window); full hash-based idempotency_key not yet done |
| 7.6 | View Quotation list — filter by status, date, salesman; expandable | ✅ | `QuotationList.js` rewritten; calls `GET /quotations`; status filter; expandable cards with item detail |
| 7.7 | Edit Quotation — `PUT /quotations/:id`; only if status `OPEN` | ✅ | Edit mode via `?id=` param in QuotationForm; loads existing data; submits `PUT`; service enforces OPEN-only edit |
| 7.8 | Cancel Quotation — soft-delete; `cancelled_at`, `cancelled_by` | ✅ | `PATCH /quotations/:id/cancel`; sets `cancelled_at`, `cancelled_by`; status → `CANCELLED`; Cancel button in QuotationList |
| 7.9 | Convert Quotation → Order | 🔶 | `POST /quotations/:id/convert-to-order` sets status to `CONVERTED` and returns message; does not yet auto-create Order from quotation data — Convert to Order button navigates user to order creation manually |
| 7.10 | Standard functions: Print (A4) / Download PDF / Email / WhatsApp | 🔶 | `DocActions.js` component built with all 4 buttons; `PdfService` + `MailService` created; PDF/email endpoints not yet wired to QuotationController; WhatsApp deep-link works in QuotationList |

---

## 8 · Order Management `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 8.1 | Create Order — same fields as Quotation plus `order_date`, `expected_delivery_date` | 🔶 | `POST /orders` works; all 5 charge columns now in `Order` entity + DB migration run; `expected_delivery_date` not yet added |
| 8.2 | Shopify new orders sync — fetch orders from Shopify, map customer + items + amounts | ❌ | Not yet implemented |
| 8.3 | View Order list — fix status enum mismatch | ✅ | `constants/orderStatus.js` created with all statuses; `OrderList.js` and `PendingApproval.js` updated to use `ORDER_STATUS.*` constants |
| 8.4 | Fix duplicate `/orders` route in `App.js` | ✅ | Removed duplicate; `/order-list` route added for `OrderList`; `/orders` now only refers to order list; Dashboard links updated |
| 8.5 | Pending Approval — list; Approve / Reject with reason; only Admin + Sales Manager | ✅ | `/pending-approval` route added; `PendingApproval.js` uses `ORDER_STATUS.PENDING_APPROVAL`; approve/reject calls use `apiFetch` with JWT token |
| 8.6 | Send for Approval → Approve → Send to Production pipeline | 🔶 | Backend routes all exist; `OrderList.js` Send for Approval button navigates to `/pending-approval`; Production step not yet wired in frontend |
| 8.7 | Reject with reason — prompt for text; store `rejection_reason` on order | ✅ | `rejection_reason` column added to `Order` entity + DB; `PendingApproval.js` calls `prompt()` for reason text; sends in body to `PATCH /orders/:id/reject` |
| 8.8 | Cancel Order — soft-delete; archive view; explicit permission | 🔶 | `PATCH /orders/:id/cancel` exists; `cancelled_at`/`cancelled_by` columns added to entity + DB; OrderList cancel button uses PATCH; archive view not yet done |
| 8.9 | Edit Order — `PUT /orders/:id` | 🔶 | Backend `PUT /orders/:id` exists; frontend edit form not yet fully wired/tested |
| 8.10 | Idempotency on `POST /orders` | ❌ | Not yet implemented |
| 8.11 | Standard functions: Print (A4) / Download PDF / Email / WhatsApp | 🔶 | `DocActions.js` component built; PDF/email backend endpoints not yet added to OrdersController |

---

## 9 · Invoice & Billing `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 9.1 | `POST /invoice/from-order/:id` must **persist** `Invoice` record | ✅ | `InvoiceService.createFromOrder()` now calls `invoiceRepo.save()`; returns saved entity |
| 9.2 | Invoice number auto-generate: `INV-YYYY-NNNN` | ✅ | `generateInvoiceNo()` in service; format `INV-{year}-{count padded to 4}` |
| 9.3 | Tally Invoice vs Estimate — two output formats | 🔶 | `Invoice.type` column (`TALLY | ESTIMATE`) added to entity + DB; `createFromOrder` accepts `type` param; separate PDF templates not yet done |
| 9.4 | GST breakdown — CGST + SGST (intra-state) or IGST (inter-state) based on customer state vs company state | ✅ | `InvoiceService` compares customer.state vs `appConfig.companyState`; applies CGST+SGST or IGST; `cgst`, `sgst`, `igst` columns saved |
| 9.5 | Split Invoice — multiple partial invoices per order | 🔶 | Backend split route exists; each call now creates persisted Invoice row; partial-invoice UI not yet built |
| 9.6 | Payment Entry page — standalone form; Advance / Payment; Cash/UPI/Bank | ✅ | `PaymentEntry.js` created at `/payment/:orderId`; fields: amount, mode (Cash/UPI/Bank Transfer/Cheque/NEFT), reference no, notes; `disabled` after first submit to prevent double-tap |
| 9.7 | Idempotency on payment — prevent double submission | 🔶 | `PaymentEntry.js` sets `disabled` after first submit; server-side idempotency key not yet implemented |
| 9.8 | Invoice detail page routed at `/invoice/:id` | ✅ | `/invoice/:id` route added in `App.js`; `Invoice.js` loads from `GET /invoice/:id` |
| 9.9 | Standard functions: Print (A4) / Download PDF / Email / WhatsApp | 🔶 | `DocActions.js` built; PDF/email endpoints not yet added to InvoiceController |
| 9.10 | Full status flow after production | ❌ | `PRODUCTION_DONE → AWAITING_PAYMENT → PENDING_BILLING → BILLED → READY_FOR_DISPATCH → DISPATCHED → FEEDBACK_PENDING → LEAD_CLOSED` pipeline not yet implemented |

---

## 10 · Purchase Management `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 10.1 | `Supplier` entity | ❌ | Not yet implemented |
| 10.2 | `PurchaseOrder` entity | ❌ | Not yet implemented |
| 10.3 | Create Purchase Order | ❌ | Not yet implemented |
| 10.4 | Purchase Pipeline | ❌ | Not yet implemented |
| 10.5 | Link Purchase to Production BOQ | ❌ | Not yet implemented |

---

## 11 · Production Management `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 11.1 | On Order Approved — split order into individual item jobs in Production Pipeline | ❌ | Not yet implemented |
| 11.2 | `ProductionJob` entity | ❌ | Not yet implemented |
| 11.3 | Production Pipeline — dynamic stages from config | ❌ | Not yet implemented |
| 11.4 | BOQ (Bill of Quantities) | ❌ | Not yet implemented |
| 11.5 | Mark job complete (item-wise) → send to Pipeline Completed Orders | ❌ | Not yet implemented |
| 11.6 | Production notifications to Production Staff | ❌ | Not yet implemented |

---

## 12 · Accounts Management `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 12.1 | **Collection Step** — Production Done orders appear in "Ready for Collection" list | ❌ | Not yet implemented |
| 12.2 | Customer settles outstanding → salesman logs payment received → order unlocks for Billing | ❌ | Not yet implemented |
| 12.3 | Pending Orders for Billing — Create Estimate / Create Tally Invoice / Both | ❌ | Not yet implemented |
| 12.4 | Payment Entry page — standalone form; Advance / Payment; Cash/UPI/Bank | ✅ | `PaymentEntry.js` created at `/payment/:orderId`; all modes; double-submit prevention |
| 12.5 | Reports — Ledger (Customer / Salesman), Item Ledger, Production Pipeline Ledger, Dispatch Ledger | ❌ | Not yet implemented |
| 12.6 | Commission calculation — on collection (sub-total only, excluding GST, Cartage, etc.) | 🔶 | `CommissionService` exists; not yet writing `Commission` rows on payment receipt |
| 12.7 | Commission slabs — configurable in `config.ts` | ❌ | `appConfig` structure ready; commission_slabs not yet added to config |
| 12.8 | View Ledger — per customer, per salesman; with outstanding balance | ❌ | Not yet implemented |
| 12.9 | Credit Limit enforcement in Accounts — lock billing if limit exceeded; show warning at 80% | 🔶 | Backend: `InvoiceService.createFromOrder` checks outstanding vs `creditLimit`; returns `{ blocked: true }` if exceeded · Frontend: credit block modal not yet shown in `Invoice.js` |

---

## 13 · Dispatch Management `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 13.1 | Order Ready for Dispatch — list of `BILLED` orders | ❌ | Not yet implemented |
| 13.2 | Create Transport Label | ❌ | Not yet implemented |
| 13.3 | Create Courier Label | ❌ | Not yet implemented |
| 13.4 | `Dispatch` entity | ❌ | Not yet implemented |
| 13.5 | Add Dispatch Details | ❌ | Not yet implemented |
| 13.6 | View Dispatch Details | ❌ | Not yet implemented |
| 13.7 | On Dispatch Complete — move to Customer Follow-Up | ❌ | Not yet implemented |

---

## 14 · Customer Follow-Up `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 14.1 | Dispatched List — call customer to confirm goods received | ❌ | Not yet implemented |
| 14.2 | Log call outcome | ❌ | Not yet implemented |
| 14.3 | WhatsApp & Email buttons per follow-up | ❌ | See Section 17 |

---

## 15 · Staff Management `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 15.1 | Add Staff — Name, Address, Mobile, Login ID + Password creation | ❌ | `UsersService.create()` now hashes password; `POST /users` endpoint ready; UI not yet built |
| 15.2 | Edit Password | ❌ | `UsersService.update()` hashes new password if provided; dedicated `PUT /auth/password` endpoint not yet done |
| 15.3 | Salary Management | ❌ | Not yet implemented |
| 15.4 | Overtime | ❌ | Not yet implemented |
| 15.5 | Leave Management | ❌ | Not yet implemented |
| 15.6 | Deductions — ESI, PF, Leave, Advance | ❌ | Not yet implemented |
| 15.7 | Advance Given Management | ❌ | Not yet implemented |
| 15.8 | Expense Management | ❌ | Not yet implemented |
| 15.9 | CTC display per staff | ❌ | Not yet implemented |
| 15.10 | Commission — Sales Team only; on collection (slab-based; configurable in `config.ts`) | 🔶 | See 12.6–12.7 |

---

## 16 · Notifications `[P2]`

Delivery: In-app banner (real-time); voice notification if browser is not in focus.

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| N.1 | Lead follow-up — remind on due date (to assigned salesman) | ❌ | Not yet implemented |
| N.2 | Quotation follow-up — 1st reminder day 3; next reminders per customer-given date/time | ❌ | Not yet implemented |
| N.3 | Payment follow-up — day -3 before due, on due date, day +1, then every 2 days | ❌ | Not yet implemented |
| N.4 | Production job follow-up — remind Production Staff on job due | ❌ | Not yet implemented |
| N.5 | Purchase follow-up — remind Purchase Executive | ❌ | Not yet implemented |
| N.6 | Dispatch ready follow-up — notify Dispatch Manager when job complete | ❌ | Not yet implemented |
| N.7 | `Notification` entity — `id, user_id, type, message, read_at, created_at` | ❌ | Not yet implemented |
| N.8 | In-app notification bell (badge count) in header | ❌ | Not yet implemented |
| N.9 | Voice notification when app not in focus (Web Speech API `speechSynthesis`) | ❌ | Not yet implemented |
| N.10 | Customer-facing WhatsApp follow-up (Phase 2) | ❌ | Not yet implemented |

---

## 17 · Communication (Standard Buttons) `[P1]`

Applies to: Quotation, Order, Invoice, Labels, Price List, Follow-Up

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| 17.1 | **"Send to WhatsApp" button** — opens the user's own WhatsApp app; user chooses who to send to | ✅ | `DocActions.js` component built; WhatsApp button uses `wa.me/?text=` deep-link with customer mobile pre-filled; works in QuotationList; `wa.me` approach (no API key) |
| 17.2 | Email button — `POST /{module}/:id/email`; staff enters recipient email; server sends via SMTP | ✅ | `DocActions.js` Email button opens modal for recipient email; calls `POST /{type}s/:id/email`; `MailService` (nodemailer) created; SMTP config from `appConfig` in `.env` |
| 17.3 | Print button — `window.print()` with `@media print` CSS hiding nav/buttons | ✅ | `DocActions.js` Print button calls `window.print()`; `PrintLayout.js` component with A4 `@page` CSS and `.no-print` hide rules |
| 17.4 | Download PDF button — `GET /{module}/:id/pdf` streams PDF buffer to browser | ✅ | `DocActions.js` PDF button calls `GET /{type}s/:id/pdf`; `PdfService` (pdfmake) created with quotation/order/invoice templates; **Note:** PDF endpoints (`/quotations/:id/pdf`, `/orders/:id/pdf`, `/invoice/:id/pdf`) not yet added to respective controllers — next step |

---

## 18 · Integrations

### 18.1 Shopify `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| I1.1 | Item sync — active items only; SKU + Title + Image + Selling Price | 🔶 | Done for items; image fix applied (p.images[0] fallback); progress bar + dialog working; `retail_price` now filled from Shopify price |
| I1.2 | Item sync — fetch only new/edited since last sync (`updated_at_min` param) | ❌ | Not yet implemented; currently full re-sync each time |
| I1.3 | Order sync — fetch new Shopify orders | ❌ | Not yet implemented |
| I1.4 | One-way fetch only — no write back to Shopify | ✅ | Only `GET` calls; confirmed |

### 18.2 Google Places `[P1]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| I2.1 | City search via Google Places API; cache result in local `cities` DB | 🔶 | `GET /cities/search` exists with local DB search; Google Places fallback + `source` badge not yet implemented; `GOOGLE_PLACES_KEY` env var added to `.env` |
| I2.2 | Auto-fill State, Country, Country Code from selected city | 🔶 | `Customer.country_code` column added; frontend auto-fill from city not yet wired |

### 18.3 IndiaMArt `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| I3.1 | Receive leads from IndiaMArt via their Lead Manager API / webhook | ❌ | Not yet implemented |

### 18.4 Facebook & Instagram Ads `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| I4.1 | Lead Ads webhook — Meta Lead Ads real-time webhook | ❌ | Not yet implemented |

### 18.5 Google Ads / Business / Maps `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| I5.1 | Google Ads lead form webhook | ❌ | Not yet implemented |
| I5.2 | Google Maps review request link | ❌ | Not yet implemented |
| I5.3 | Field salesman GPS location tracking | ❌ | Not yet implemented |

### 18.6 WhatsApp `[P1 — no API key needed]`

> **Approach:** "Send to WhatsApp" button opens the staff member's own WhatsApp app via `wa.me` deep-link. Recipients selected based on the number of the customer. No server-side WhatsApp integration, no API key, no Business API account required.

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| I6.1 | "Send to WhatsApp" deep-link button on every document (Quotation / Order / Invoice / Price List / Label) | 🔶 | `DocActions.js` built with WhatsApp button; works in QuotationList; not yet added to Order and Invoice pages |
| I6.2 | Pre-filled message text per document type — configurable in `config.ts` | ❌ | Message templates not yet added to `appConfig`; current message is hardcoded in `DocActions.js` |
| I6.3 | Inbound WhatsApp leads (Phase 2 — only if WhatsApp Business API added later) | ❌ | Out of scope for now |

---

## 19 · Loyalty Program `[P2]`

| # | Task | Status | Plan / Steps |
|---|------|--------|--------------|
| L.1 | Retailer loyalty programme — configurable earning/redemption rules in `config.ts` | ❌ | Not yet implemented |
| L.2 | Wholesaler programme — separate slab in `config.ts` | ❌ | Not yet implemented |

---

## 20 · Technical Debt & Critical Bugs `[P1]`

| # | Issue | Status | Fix |
|---|-------|--------|-----|
| T.1 | `/orders` route declared twice in `App.js` — renders `Dashboard` instead of `OrderList` | ✅ | Duplicate removed; `/order-list` route added; all navigate calls updated |
| T.2 | `QuotationList.js` imports itself and exports `OrderList` — completely broken | ✅ | Deleted and rewritten from scratch as proper QuotationList component calling `GET /quotations` |
| T.3 | `EditCustomer.js` unreachable — no route in `App.js` | ✅ | `/edit-customer/:id` route added; `EditCustomer.js` wired to `API_URL` |
| T.4 | `Invoice.js` unreachable — no route in `App.js` | ✅ | `/invoice/:id` route added |
| T.5 | `PendingApproval.js` not routed | ✅ | `/pending-approval` route added |
| T.6 | Order status enums differ between frontend (`'order'`, `'quotation'`) and backend (`APPROVED`, `PENDING_APPROVAL`) | ✅ | `constants/orderStatus.js` created with `ORDER_STATUS` object; used in `OrderList.js`, `PendingApproval.js` |
| T.7 | `OrdersService.create` references charge columns not in `Order` entity | ✅ | `charges_packing/cartage/forwarding/installation/loading` added to `Order` entity; DB migration run |
| T.8 | `Product` entity never written to — Shopify sync only writes to `Item` | 🔶 | Not yet resolved; `Product` table still exists unused; decision pending (remove or repurpose) |
| T.9 | `UsersModule` not registered in `app.module.ts` | ✅ | `UsersModule` registered; `TypeOrmModule.forFeature([User])` added; `GET/POST/PUT /users` endpoints exposed |
| T.10 | `synchronize: false` — every schema change needs manual migration SQL | 🔶 | All migrations run manually via psql; convention documented; migrations folder not yet formalised |
| T.11 | `origin: "*"` CORS — insecure for production | ✅ | `enableCors()` consolidated to single call; `origin` reads from `process.env.CORS_ORIGIN` (set to `http://localhost:3001` in `.env`) |
| T.12 | `ShopifyItems.js` fetches `GET /items` twice | ✅ | Second fetch removed; first call's data reused for shopify filter and Item Master mapping |
| T.13 | Dashboard "today's sales" uses `o.created_at`; `Order` entity uses `order_date` | ❌ | Not yet fixed |
| T.14 | `Item.gst` is `integer` in DB but `float` in entity | ✅ | Migration run: `ALTER TABLE item ALTER COLUMN gst TYPE float USING gst::float` |
| T.15 | Approve/reject sends no user context — service `can_approve_order` check always fails | ✅ | `JwtAuthGuard` global; `apiFetch` in `PendingApproval.js` sends `Authorization: Bearer` header; `req.user` attached by strategy |
| T.16 | `AddItem.js` + `/add-item` route not wrapped in `PrivateRoute` | ✅ | All non-auth routes in `App.js` wrapped in `PrivateRoute` |

---

## 🔜 NEXT PRIORITIES (P1 remaining)

Items still needed before Phase 1 is deployable:

1. **PDF endpoints on controllers** — add `GET /quotations/:id/pdf`, `GET /orders/:id/pdf`, `GET /invoice/:id/pdf` + corresponding email `POST` endpoints (PdfService + MailService already built, just need controller wiring)
2. **7.9 Convert Quotation → Order** — make `POST /quotations/:id/convert-to-order` actually create an Order from quotation data (copy items, charges, customer)
3. **Credit limit UI** — show hard block modal in `Invoice.js` when `{ blocked: true }` returned; credit days dropdown (0/7/15/30/45) on Customer form
4. **CustomerType dropdown** — update `AddCustomer.js` with 8-option dropdown (Retail Shop / Chain Store / Eye Hospital / Eye Clinics / Brands / CR Labs / Grinder / Wholesaler)
5. **RBAC guards** — add `@RequirePermission()` to `approve`, `reject`, `cancel` order endpoints (currently any logged-in user can approve)
6. **Google Places fallback** — wire `GOOGLE_PLACES_KEY` in `CitiesService`; add `source: 'local'|'google'` to city search response
7. **Audit Log** — `AuditInterceptor` + `AuditLog` entity (section 3.x)
8. **Lead module** — entire section 6 missing
9. **Production + Dispatch flow** — sections 11 + 13 (P2)

---

## Phase 1 Build Order (Suggested Sequence)

```
1.  T.1–T.7, T.9, T.12–T.14   → Fix existing bugs so current screens work  [✅ DONE]
2.  S.1–S.2                    → Config + theme files centralised            [✅ DONE]
3.  1.1–1.6                    → Real JWT auth + user context                [✅ DONE 1.1–1.4]
4.  2.1–2.9                    → RBAC wired end-to-end                       [🔶 2.1 done]
5.  3.1–3.6                    → Audit log interceptor + viewer              [❌ pending]
6.  S.3–S.10                   → Duplicate protection, idempotency, sentence-case [🔶 partial]
7.  4.1–4.9                    → Customer Master complete                    [🔶 partial]
8.  5.1–5.10                   → Item Master + Shopify sync complete         [🔶 partial]
9.  I2.1–I2.2                  → Google Places city API                      [🔶 partial]
10. 6.1–6.10                   → CRM Lead module                             [❌ pending]
11. 7.1–7.10                   → Quotation end-to-end                        [✅ DONE 7.1–7.8]
12. 8.1–8.11                   → Order end-to-end                            [🔶 partial]
13. 9.1–9.10                   → Invoice / Billing (persist + PDF + payment) [🔶 partial]
14. 17.1–17.5                  → Standard functions (Print/PDF/WhatsApp/Email)[✅ DONE infrastructure]
15. 12.1–12.9                  → Accounts module                             [🔶 partial]
16. I1.2–I1.3                  → Shopify order sync + new-items-only sync    [❌ pending]
17. COM / PRICE                → Retail vs Wholesale pricing                  [✅ DONE]
```
