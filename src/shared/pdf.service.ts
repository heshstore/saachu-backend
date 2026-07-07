import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { appConfig } from '../config/config';

// pdfmake v0.3 exports a singleton instance — not a constructor class.

const pdfmake = require('pdfmake');

// Absolute paths to TTF files shipped inside the pdfmake package.
// process.cwd() is the project root (backend/), stable across src/ and dist/.
const FONT_DIR = path.join(
  process.cwd(),
  'node_modules',
  'pdfmake',
  'fonts',
  'Roboto',
);

try {
  pdfmake.setFonts({
    Roboto: {
      normal: path.join(FONT_DIR, 'Roboto-Regular.ttf'),
      bold: path.join(FONT_DIR, 'Roboto-Medium.ttf'),
      italics: path.join(FONT_DIR, 'Roboto-Italic.ttf'),
      bolditalics: path.join(FONT_DIR, 'Roboto-MediumItalic.ttf'),
    },
  });
  // Allow pdfmake to read local TTF files from disk.
  pdfmake.setUrlAccessPolicy(() => true);
} catch (e: any) {
  new Logger('PdfService').error(`pdfmake font setup failed: ${e?.message}`);
}

const SLATE_OWN = '#64748b';

/**
 * Customer snapshots store the full address as a single comma-joined blob
 * built (in this fixed relative order) from street/city/state/pincode/country
 * — see snapshotCustomer in quotation.service.ts / orders.service.ts — but
 * empty fields are dropped, so the blob can have anywhere from 1 to 5 parts.
 * Address/country are the only genuinely optional fields (city/state/pincode
 * are required Customer columns), so instead of counting from either end we
 * anchor on the pincode (the one segment that looks like a 4-6 digit number)
 * and count exactly 2 fields back for state/city — that holds regardless of
 * whether the street address or country segment is present.
 */
/**
 * pdfmake sizes a '*'-width column from its content's longest unbreakable
 * token, since it (like PDFKit) only wraps at existing break points — it
 * won't split a word mid-way to fit. A long unbroken run typed with no
 * spaces (a pasted string, mashed keys, etc.) in a proportional-width
 * column therefore forces that column wider than its fair share, pushing
 * whatever comes after it (e.g. the Totals column) off the right edge of
 * the page. Zero-width spaces are invisible but are a valid line-break
 * point under the Unicode line-breaking rules pdfmake follows, so inserting
 * one every `maxLen` characters inside over-long tokens gives it somewhere
 * safe to wrap without changing how the text looks.
 */
function breakLongWords(text: string | null | undefined, maxLen = 18): string {
  if (!text) return '';
  return String(text)
    .split(' ')
    .map((word) =>
      word.length > maxLen
        ? (word.match(new RegExp(`.{1,${maxLen}}`, 'g')) || [word]).join('​')
        : word,
    )
    .join(' ');
}

function splitAddressBlock(fullAddress: string | null | undefined): {
  street: string;
  cityLine: string;
  stateLine: string;
} {
  const parts = String(fullAddress || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const pincodeIdx = parts.findIndex((p) => /^\d{4,6}$/.test(p));
  if (pincodeIdx === -1)
    return { street: parts.join(', '), cityLine: '', stateLine: '' };
  let pincode = parts[pincodeIdx];
  if (/^\d{6}$/.test(pincode))
    pincode = `${pincode.slice(0, 3)} ${pincode.slice(3)}`;
  const state = pincodeIdx >= 1 ? parts[pincodeIdx - 1] : '';
  const city = pincodeIdx >= 2 ? parts[pincodeIdx - 2] : '';
  const country = parts.slice(pincodeIdx + 1).join(', ');
  const street =
    pincodeIdx >= 3 ? parts.slice(0, pincodeIdx - 2).join(', ') : '';
  return {
    street,
    cityLine: [city, pincode].filter(Boolean).join(' - '),
    stateLine: [state, country].filter(Boolean).join(', '),
  };
}

function ownershipPdfStack(
  data: any,
  opts?: { showPhone?: boolean; approvalPending?: boolean },
) {
  const lines: any[] = [];
  const salesName = data?.salesman_name || data?.sales_person;
  if (salesName) {
    const parts = [
      salesName,
      data?.salesman_role,
      opts?.showPhone !== false ? data?.salesman_phone : null,
    ].filter(Boolean);
    lines.push({
      text: [
        { text: 'Sales     ', bold: true, color: SLATE_OWN },
        parts.join(' · '),
      ],
      fontSize: 8,
    });
  }
  if (data?.approved_by_name) {
    const appr = data.approved_by_role
      ? `${data.approved_by_name} (${data.approved_by_role})`
      : data.approved_by_name;
    lines.push({
      text: [{ text: 'Approved  ', bold: true, color: SLATE_OWN }, appr],
      fontSize: 8,
    });
  } else if (opts?.approvalPending) {
    lines.push({
      text: [
        { text: 'Approved  ', bold: true, color: SLATE_OWN },
        'Pending Approval',
      ],
      fontSize: 8,
      italics: true,
      color: '#b45309',
    });
  }
  if (data?.generated_by_name) {
    const gen = data.generated_by_role
      ? `${data.generated_by_name} (${data.generated_by_role})`
      : data.generated_by_name;
    lines.push({
      text: [{ text: 'Generated ', bold: true, color: SLATE_OWN }, gen],
      fontSize: 8,
    });
  }
  return lines;
}

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  private ensureUploadsDir(): string {
    const dir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private resolveStaticImage(filename: string): string | null {
    const p = path.join(process.cwd(), 'static', filename);
    return fs.existsSync(p) ? p : null;
  }

  /**
   * pdfmake can't embed a remote URL directly — it needs a local file path
   * or a base64 data URI. Fetches the item-master product photo and inlines
   * it; returns null (falling back to the placeholder box) on any failure
   * so a broken/slow image never breaks PDF generation.
   */
  private async fetchImageDataUri(url: string): Promise<string | null> {
    if (!url) return null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return `data:${contentType};base64,${buf.toString('base64')}`;
    } catch (err: any) {
      this.logger.warn(`[PDF_IMAGE_FETCH_FAILED] ${url}: ${err?.message}`);
      return null;
    }
  }

  /** Batch-resolves a set of item photo URLs to data URIs, deduping repeats. */
  private async fetchImageMap(
    urls: (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(urls.filter((u): u is string => !!u))];
    const map = new Map<string, string>();
    await Promise.all(
      unique.map(async (u) => {
        const dataUri = await this.fetchImageDataUri(u);
        if (dataUri) map.set(u, dataUri);
      }),
    );
    return map;
  }

  // ── Template: Quotation ──────────────────────────────────────────────────────

  async quotationTemplate(data: any): Promise<any> {
    const BLUE = '#016bb2';
    const SLATE = '#64748b';
    const INK = '#0f172a';
    const RULE = '#cbd5e1';

    const safe = (v: any, fallback = '—') =>
      v != null && String(v).trim() !== '' ? String(v) : fallback;
    const fmt2 = (n: any) =>
      Number(n || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    const inr = (n: any) => `₹${fmt2(n)}`;
    const fmtDate = (dt: Date) => {
      const d = String(dt.getDate()).padStart(2, '0');
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      return `${d}/${m}/${dt.getFullYear()}`;
    };
    const today = fmtDate(new Date());
    const dateStr = (d: any) => {
      try {
        return d ? fmtDate(new Date(d)) : today;
      } catch {
        return today;
      }
    };

    const rows = Array.isArray(data?.items) ? data.items : [];
    // Tax mode is set per item now, not per document — show "Mixed" when
    // items disagree instead of a single (possibly wrong) document-wide label.
    const taxLabel =
      rows.length === 0
        ? data?.is_tax_inclusive
          ? '(Tax Incl.)'
          : '(Tax Extra)'
        : rows.every((it: any) => !!it?.is_tax_inclusive)
          ? '(Tax Incl.)'
          : rows.every((it: any) => !it?.is_tax_inclusive)
            ? '(Tax Extra)'
            : '(Mixed)';
    const itemImageMap = await this.fetchImageMap(
      rows.map((it: any) => it?.image_url),
    );
    const companyName =
      appConfig?.companyName || 'Hesh Opto Lab Private Limited';
    const companyAddr =
      appConfig?.companyAddress ||
      'No. 207 / 208 / 209, Sri Selva Vinayagar Nagar, Alinjivakkam,\nRedhills, Chennai, Tamil Nadu, 600052';
    const companyPhone = appConfig?.companyPhone || '7010366206';
    const companyEmail =
      appConfig?.companyEmail || 'heshstoreaccounts@hotmail.com';
    const companyGstin = appConfig?.companyGstin || '33AABCH5436K1ZM';
    const bankAccName =
      appConfig?.bankAccountName || 'Hesh Opto Lab Private Limited';
    const bankName = appConfig?.bankName || 'Kotak Mahindra Bank';
    const bankBranch = appConfig?.bankBranch || 'Parrys Chennai';
    const bankAccount = appConfig?.bankAccount || '5811128721';
    const bankIfsc = appConfig?.bankIfsc || 'KKBK0000464';
    const companyPan = process.env.COMPANY_PAN || 'AABCH5436K';

    const subTotal = Number(data?.sub_total) || 0;
    const chargePack = Number(data?.charges_packing) || 0;
    const chargeCar = Number(data?.charges_cartage) || 0;
    const chargeFwd = Number(data?.charges_forwarding) || 0;
    const chargeInst = Number(data?.charges_installation) || 0;
    const chargeLoad =
      Number(
        data?.charges_loading ||
          data?.loading_charges ||
          data?.loading_unloading,
      ) || 0;
    const roundOff =
      Number(data?.round_off ?? data?.roundoff ?? data?.roundOff) || 0;
    const gstByRate = new Map<number, number>();
    for (const it of rows) {
      const base = Number(it?.amount) || 0;
      const pct = Number(it?.gst_percent) || 0;
      if (pct > 0)
        gstByRate.set(pct, (gstByRate.get(pct) || 0) + (base * pct) / 100);
    }
    const grandTotal = Number(data?.total_amount) || 0;

    const custName = safe(data?.customer_name, '');
    const custEmail = safe(data?.customer_email, '');
    const billAddr = safe(data?.billing_address, '');
    const shipAddr = safe(data?.shipping_address || data?.billing_address, '');
    const quotNo = safe(data?.quotation_no, '');
    const quoteDate = dateStr(data?.created_at || data?.quotation_date);

    // Dispatch fields
    const qBookingAt = safe(data?.booking_at, '');
    const qGoodsSentBy = safe(data?.goods_sent_by || data?.delivery_by, '');
    const qTransportPaymentBy = safe(
      data?.transport_payment_by || data?.payment_type || data?.payment_mode,
      '',
    );
    const qDeliveryType = safe(data?.delivery_type, '');
    const qDeliveryInstructions = safe(data?.delivery_instructions, '');

    // Logo image
    const logoPath = this.resolveStaticImage('logo.png');
    const qrPath = this.resolveStaticImage('QR.jpg');

    // Items table rows: S.No | Photo | Item/SKU/HSN | Instruction | Qty | Unit | [Disc] | Rate | GST | Amount
    // The Disc column only appears at all if at least one line item actually has a discount.
    const hasAnyDiscount = rows.some(
      (it: any) => Number(it?.discount_value) > 0,
    );
    const COLS = hasAnyDiscount ? 10 : 9;
    const itemRows: any[] = rows.map((it: any, i: number) => {
      const base = Number(it?.amount) || 0;
      const rate = Number(it?.rate || 0);
      const qty = Number(it?.qty) || 0;
      const gstPct = Number(it?.gst_percent) || 0;
      const discVal = Number(it?.discount_value) || 0;
      // Only two values are ever saved by the form: 'percent' or 'fixed'.
      // Treat anything other than 'percent' as a flat rupee discount rather
      // than matching specific strings ('flat'/'rs'/'amount') that the form
      // never actually sends — that mismatch silently misread every ₹
      // discount as a % discount.
      const discType = String(it?.discount_type || 'percent').toLowerCase();
      const isFlatDisc = discType !== 'percent';
      // Discount is always per piece: a % discount is a % of the per-unit
      // rate, and a flat discount is a rupee amount off the per-unit rate —
      // neither is computed against rate × qty.
      const perUnitDiscAmt = isFlatDisc ? discVal : (rate * discVal) / 100;
      const discountedRate = Math.max(0, rate - perUnitDiscAmt);

      let discCell: any;
      if (discVal > 0) {
        discCell = {
          stack: [
            {
              text: isFlatDisc ? `₹${fmt2(discVal)}` : `${discVal}%`,
              fontSize: 7,
              bold: true,
              color: INK,
            },
            // Non-breaking space keeps "on ₹..." / "= ₹..." glued together —
            // a regular space lets pdfmake wrap right after "on"/"=" when the
            // amount is large, isolating the symbol on its own line.
            {
              text: `on ₹${fmt2(rate)}`,
              fontSize: 6,
              color: SLATE,
              margin: [0, 2, 0, 0],
            },
            {
              text: `= ₹${fmt2(isFlatDisc ? discountedRate : perUnitDiscAmt)}`,
              fontSize: 7,
              bold: true,
              color: INK,
              margin: [0, 3, 0, 0],
            },
          ],
          alignment: 'center',
          margin: [0, 4, 0, 0],
        };
      } else {
        discCell = { text: '', fontSize: 7, alignment: 'center' };
      }

      // Real item-master photo when available; otherwise the gray placeholder box.
      const photoDataUri = it?.image_url
        ? itemImageMap.get(it.image_url)
        : null;
      const photoCell = photoDataUri
        ? {
            image: photoDataUri,
            fit: [24, 24],
            alignment: 'center',
            margin: [2, 3, 2, 2],
          }
        : {
            stack: [
              {
                canvas: [
                  {
                    type: 'rect',
                    x: 1,
                    y: 1,
                    w: 24,
                    h: 24,
                    r: 3,
                    color: '#e2e8f0',
                  },
                  {
                    type: 'ellipse',
                    x: 13,
                    y: 10,
                    r1: 4,
                    r2: 4,
                    color: '#94a3b8',
                  },
                  {
                    type: 'rect',
                    x: 4,
                    y: 16,
                    w: 17,
                    h: 7,
                    r: 2,
                    color: '#cbd5e1',
                  },
                ],
              },
              {
                text: 'Photo',
                fontSize: 6,
                alignment: 'center',
                color: '#94a3b8',
                margin: [0, 1, 0, 0],
              },
            ],
            margin: [2, 3, 2, 2],
          };

      return [
        {
          text: String(i + 1),
          alignment: 'center',
          fontSize: 8,
          margin: [0, 5, 0, 0],
        },
        photoCell,
        {
          stack: [
            ...(it?.sku
              ? [{ text: it.sku, fontSize: 7, bold: true, color: BLUE }]
              : []),
            {
              text: safe(it?.item_name || it?.itemName, `Item ${i + 1}`),
              fontSize: 8,
              bold: true,
            },
            ...(it?.hsn_code
              ? [{ text: `HSN: ${it.hsn_code}`, fontSize: 6.5, color: SLATE }]
              : []),
          ],
          margin: [0, 3, 0, 3],
        },
        {
          text: breakLongWords(
            safe(it?.instruction || it?.instructions || it?.notes, ''),
          ),
          fontSize: 7,
          color: SLATE,
          margin: [0, 3, 0, 3],
        },
        {
          text: String(qty),
          alignment: 'center',
          fontSize: 8,
          margin: [0, 5, 0, 0],
        },
        {
          text: safe(it?.unit || '', ''),
          alignment: 'center',
          fontSize: 8,
          margin: [0, 5, 0, 0],
        },
        ...(hasAnyDiscount ? [discCell] : []),
        {
          text: inr(discVal > 0 ? discountedRate : rate),
          alignment: 'right',
          fontSize: 7.5,
          margin: [0, 5, 0, 0],
        },
        gstPct > 0
          ? {
              stack: [
                {
                  text: `${gstPct}%`,
                  fontSize: 7.5,
                  bold: true,
                  alignment: 'center',
                },
                {
                  text: inr((base * gstPct) / 100),
                  fontSize: 5.5,
                  color: SLATE,
                  alignment: 'center',
                },
              ],
              margin: [0, 4, 0, 0],
            }
          : { text: '', fontSize: 8 },
        {
          text: inr(base),
          alignment: 'right',
          fontSize: 7.5,
          bold: true,
          margin: [0, 5, 0, 0],
        },
      ];
    });

    if (itemRows.length === 0) {
      itemRows.push([
        {
          text: 'No items',
          colSpan: COLS,
          alignment: 'center',
          fontSize: 8,
          color: SLATE,
        },
        ...Array(COLS - 1).fill({}),
      ]);
    }

    // Account details (left of bottom section)
    const bankRow = (label: string, value: string) => ({
      columns: [
        { text: label, bold: true, fontSize: 8, width: 110, color: INK },
        { text: value, fontSize: 8, width: '*', color: '#374151' },
      ],
      columnGap: 4,
      margin: [0, 0, 0, 3],
    });
    const accountLines: any[] = [
      bankRow("Account Holder's Name:", bankAccName),
      bankRow('Account Number:', bankAccount),
      bankRow('Bank Name:', bankName),
      bankRow('Branch Name:', bankBranch),
      bankRow('IFSC Code:', bankIfsc),
    ];

    // Totals (right of bottom section)
    const tRow = (
      label: string,
      value: number,
      bold = false,
      large = false,
    ) => ({
      columns: [
        {
          text: label,
          fontSize: large ? 10 : 8.5,
          bold,
          color: large ? BLUE : INK,
          width: '*',
        },
        {
          text: inr(value),
          fontSize: large ? 10 : 8.5,
          bold,
          color: large ? BLUE : INK,
          width: 'auto',
          alignment: 'right',
        },
      ],
      margin: [0, large ? 2 : 1, 0, large ? 2 : 1],
    });
    const tDiv = () => ({
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 0,
          x2: 200,
          y2: 0,
          lineWidth: 0.5,
          lineColor: '#999',
        },
      ],
      margin: [0, 3, 0, 3],
    });
    const totalBeforeGst =
      subTotal + chargePack + chargeCar + chargeFwd + chargeInst + chargeLoad;
    const totalGstAmt = [...gstByRate.values()].reduce((s, a) => s + a, 0);
    const computedGrandTotal = totalBeforeGst + totalGstAmt + roundOff;
    const totalsStack: any[] = [
      tRow('Sub Total', subTotal, true, true),
      ...(chargePack > 0
        ? [tRow('(+) Wooden Packing Charges', chargePack)]
        : []),
      ...(chargeCar > 0 ? [tRow('(+) Cartage Charges', chargeCar)] : []),
      ...(chargeFwd > 0 ? [tRow('(+) Forwarding Charges', chargeFwd)] : []),
      ...(chargeInst > 0
        ? [tRow('(+) Onsite Installation Charges', chargeInst)]
        : []),
      ...(chargeLoad > 0
        ? [tRow('(+) Loading & Unloading Charges', chargeLoad)]
        : []),
      tDiv(),
      tRow('Total', totalBeforeGst, true, true),
      tDiv(),
      ...[...gstByRate.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([pct, amt]) =>
          tRow(`(+) GST ${pct}% on ${inr((amt * 100) / pct)}`, amt),
        ),
      tDiv(),
      tRow('Rounded Off', roundOff),
      tDiv(),
      tRow('Grand Total', computedGrandTotal, true, true),
      tDiv(),
    ];

    const termsText =
      'TERMS & CONDITIONS\n' +
      '• Prices are valid only for this quotation and are subject to change without prior notice. ' +
      '• Order confirmation is subject to receipt of the agreed advance payment. ' +
      '• Delivery timelines commence only after advance payment and final order confirmation. ' +
      '• Any change in order specifications may affect pricing and delivery schedules. ' +
      '• Goods once sold will not be taken back except for approved manufacturing defects. ' +
      '• Risk in transit passes to the buyer upon dispatch. Transit damage claims must be made with the transporter. ' +
      '• Delivery delays due to force majeure or unforeseen circumstances shall not be the responsibility of the company. ' +
      '• Refunds, if approved, will be processed within 10 working days after verification. ' +
      '• GST and other applicable taxes will be charged as per prevailing rates on the invoice date. ' +
      '• Product specifications, prices, and designs are subject to change without prior notice. ' +
      '• All disputes shall be subject to the exclusive jurisdiction of the courts in Chennai, Tamil Nadu.';

    return {
      pageSize: 'A4',
      pageMargins: [36, 30, 36, 40],
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 0, 36, 10],
        text: `Page ${currentPage}/${pageCount}`,
        fontSize: 8,
        italics: true,
        alignment: 'center',
        color: SLATE,
      }),
      content: [
        // ── Title ────────────────────────────────────────────────────────
        {
          text: 'Quotation',
          fontSize: 16,
          bold: true,
          alignment: 'center',
          margin: [0, 0, 0, 3],
        },

        // ── Header ───────────────────────────────────────────────────────
        {
          columns: [
            {
              width: '*',
              stack: [
                {
                  text: companyName,
                  fontSize: 13,
                  bold: true,
                  margin: [0, 0, 0, 3],
                },
                {
                  text: companyAddr.replace(/\n/g, ', '),
                  fontSize: 7,
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    { text: 'Mobile: ', bold: true, fontSize: 7 },
                    { text: companyPhone, fontSize: 7, color: '#374151' },
                    { text: '     ·     ', fontSize: 7, color: SLATE },
                    { text: 'Email: ', bold: true, fontSize: 7 },
                    { text: companyEmail, fontSize: 7, color: '#374151' },
                  ],
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    { text: 'MSME Reg. No.: ', bold: true, fontSize: 7 },
                    {
                      text: 'UDYAM-TN-02-0034349',
                      fontSize: 7,
                      color: '#374151',
                    },
                  ],
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    {
                      text: 'ISO 9001 : 2015 Certified',
                      bold: true,
                      fontSize: 7,
                      color: BLUE,
                    },
                    { text: '  |  QMS System', fontSize: 7, color: SLATE },
                  ],
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    { text: 'GSTIN: ', bold: true, fontSize: 7.5 },
                    { text: companyGstin, bold: true, fontSize: 7.5 },
                  ],
                },
              ],
            },
            ...(logoPath
              ? [
                  {
                    image: logoPath,
                    fit: [152, 97],
                    width: 158,
                    alignment: 'right',
                  },
                ]
              : []),
          ],
          columnGap: 8,
          margin: [0, 0, 0, 3],
        },

        // ── Bill To / Ship To / Quotation Details ───────────────────────
        (() => {
          const phone = safe(data?.customer_phone, '').replace(/^\+91/, '');
          const phone2 = safe(
            data?.customer_phone2 || data?.mobile2,
            '',
          ).replace(/^\+91/, '');
          const validity = data?.valid_till
            ? dateStr(data.valid_till)
            : data?.validity_days
              ? `${data.validity_days} days from date`
              : '30 days from date';

          const labelVal = (
            label: string,
            value: string,
            marginBottom = 5,
          ) => ({
            columns: [
              {
                text: label,
                bold: true,
                fontSize: 8,
                width: 'auto',
                color: INK,
              },
              {
                text: value,
                fontSize: 8,
                width: '*',
                color: '#374151',
                margin: [3, 0, 0, 0],
              },
            ],
            columnGap: 0,
            margin: [0, 0, 0, marginBottom],
          });

          const partyStack = (addr: string) => {
            const { street, cityLine, stateLine } = splitAddressBlock(addr);
            return {
              stack: [
                {
                  text: custName.toUpperCase(),
                  fontSize: 9.5,
                  bold: true,
                  color: INK,
                  margin: [0, 0, 0, 5],
                },
                {
                  canvas: [
                    {
                      type: 'line',
                      x1: 0,
                      y1: 0,
                      x2: 160,
                      y2: 0,
                      lineWidth: 0.4,
                      lineColor: RULE,
                    },
                  ],
                  margin: [0, 0, 0, 5],
                },
                ...(street
                  ? [
                      {
                        text: street,
                        fontSize: 8,
                        color: '#374151',
                        lineHeight: 1.3,
                        margin: [0, 0, 0, 2],
                      },
                    ]
                  : []),
                ...(cityLine
                  ? [
                      {
                        text: cityLine,
                        fontSize: 8,
                        color: '#374151',
                        margin: [0, 0, 0, 2],
                      },
                    ]
                  : []),
                ...(stateLine
                  ? [
                      {
                        text: stateLine,
                        fontSize: 8,
                        color: '#374151',
                        margin: [0, 0, 0, 5],
                      },
                    ]
                  : []),
                ...(!street && !cityLine && !stateLine
                  ? [
                      {
                        text: '—',
                        fontSize: 8,
                        color: '#374151',
                        margin: [0, 0, 0, 5],
                      },
                    ]
                  : []),
                ...(custEmail
                  ? [
                      {
                        text: [
                          { text: 'Email: ', bold: true, fontSize: 8 },
                          { text: custEmail, fontSize: 8, color: '#374151' },
                        ],
                        margin: [0, 0, 0, 3],
                      },
                    ]
                  : []),
                ...(phone
                  ? [
                      {
                        text: [
                          { text: 'Mobile 1: ', bold: true, fontSize: 8 },
                          { text: phone, bold: true, fontSize: 8, color: INK },
                        ],
                        margin: [0, 0, 0, 3],
                      },
                    ]
                  : []),
                ...(phone2
                  ? [
                      {
                        text: [
                          { text: 'Mobile 2: ', bold: true, fontSize: 8 },
                          { text: phone2, bold: true, fontSize: 8, color: INK },
                        ],
                        margin: [0, 0, 0, 3],
                      },
                    ]
                  : []),
                {
                  canvas: [
                    {
                      type: 'line',
                      x1: 0,
                      y1: 0,
                      x2: 160,
                      y2: 0,
                      lineWidth: 0.4,
                      lineColor: RULE,
                    },
                  ],
                  margin: [0, 4, 0, 4],
                },
                {
                  text: [
                    { text: 'GSTIN: ', bold: true, fontSize: 8 },
                    {
                      text: safe(data?.gst_number, '') || 'URD',
                      bold: true,
                      fontSize: 8,
                      color: INK,
                    },
                  ],
                },
              ],
              margin: [5, 5, 5, 5],
            };
          };

          return {
            table: {
              widths: ['*', '*', '*'],
              body: [
                [
                  {
                    text: 'Bill To',
                    fontSize: 10,
                    bold: true,
                    color: '#fff',
                    fillColor: BLUE,
                    margin: [6, 4, 6, 4],
                  },
                  {
                    text: 'Ship To',
                    fontSize: 10,
                    bold: true,
                    color: '#fff',
                    fillColor: BLUE,
                    margin: [6, 4, 6, 4],
                  },
                  {
                    text: 'Quotation Details',
                    fontSize: 10,
                    bold: true,
                    color: '#fff',
                    fillColor: BLUE,
                    margin: [6, 4, 6, 4],
                  },
                ],
                [
                  partyStack(billAddr),
                  partyStack(shipAddr),
                  {
                    stack: [
                      labelVal('Date:', quoteDate),
                      labelVal('Quotation No:', quotNo),
                      labelVal(
                        'Salesman:',
                        safe(data?.salesman_name || data?.sales_person, ''),
                      ),
                      labelVal('Validity:', validity),
                      {
                        canvas: [
                          {
                            type: 'line',
                            x1: 0,
                            y1: 0,
                            x2: 160,
                            y2: 0,
                            lineWidth: 0.4,
                            lineColor: RULE,
                          },
                        ],
                        margin: [0, 2, 0, 5],
                      },
                      labelVal(
                        'Payment Terms:',
                        'Advance 70% & Before Dispatch 30%',
                      ),
                      labelVal(
                        'Delivery Location:',
                        safe(data?.delivery_type || data?.delivery_by, ''),
                        0,
                      ),
                    ],
                    margin: [5, 5, 5, 5],
                  },
                ],
              ],
            },
            layout: {
              hLineWidth: (i: number) =>
                i === 0 || i === 1 || i === 2 ? 0.5 : 0,
              vLineWidth: (i: number) =>
                i === 0 || i === 1 || i === 2 || i === 3 ? 0.5 : 0,
              hLineColor: () => RULE,
              vLineColor: () => RULE,
              paddingLeft: () => 0,
              paddingRight: () => 0,
              paddingTop: () => 0,
              paddingBottom: () => 0,
            },
            margin: [0, 0, 0, 3],
          };
        })(),

        // ── Items table ──────────────────────────────────────────────────
        {
          table: {
            headerRows: 1,
            dontBreakRows: false,
            // Disc's width is simply omitted (not zeroed) when hidden — the
            // Item/Name column is the only auto ('*') column, so it absorbs
            // the freed space automatically.
            widths: [
              16,
              28,
              '*',
              36,
              16,
              18,
              ...(hasAnyDiscount ? [44] : []),
              52,
              34,
              52,
            ],
            body: [
              [
                {
                  text: 'S.No',
                  style: 'th',
                  alignment: 'center',
                  noWrap: true,
                },
                {
                  text: 'Photo',
                  style: 'th',
                  alignment: 'center',
                  noWrap: true,
                },
                { text: 'Item / Name / HSN', style: 'th' },
                { text: 'Instr.', style: 'th', noWrap: true },
                { text: 'Qty', style: 'th', alignment: 'center', noWrap: true },
                {
                  text: 'Unit',
                  style: 'th',
                  alignment: 'center',
                  noWrap: true,
                },
                ...(hasAnyDiscount
                  ? [
                      {
                        text: 'Disc',
                        style: 'th',
                        alignment: 'center',
                        noWrap: true,
                      },
                    ]
                  : []),
                {
                  text: 'Rate (₹)',
                  style: 'th',
                  alignment: 'right',
                  noWrap: true,
                },
                {
                  text: 'GST Tax',
                  style: 'th',
                  alignment: 'center',
                  noWrap: true,
                },
                {
                  stack: [
                    {
                      text: 'Amount (₹)',
                      fontSize: 8.5,
                      bold: true,
                      color: '#fff',
                    },
                    {
                      text: taxLabel,
                      fontSize: 5.5,
                      color: '#fff',
                      italics: true,
                    },
                  ],
                  alignment: 'right',
                  fillColor: BLUE,
                },
              ],
              ...itemRows,
            ],
          },
          layout: {
            hLineWidth: (i: number, node: any) =>
              i === 0 ||
              i === node.table.headerRows ||
              i === node.table.body.length
                ? 1
                : 0.4,
            vLineWidth: () => 0.4,
            hLineColor: (i: number) => (i === 0 || i === 1 ? BLUE : RULE),
            vLineColor: () => RULE,
            fillColor: (row: number) =>
              row === 0 ? BLUE : row % 2 === 0 ? '#f8fafc' : null,
            paddingLeft: () => 4,
            paddingRight: () => 4,
            paddingTop: () => 1.5,
            paddingBottom: () => 1.5,
          },
          margin: [0, 0, 0, 3],
        },

        // ── Account Details + QR | Totals ────────────────────────────────
        {
          columns: [
            // QR code
            ...(qrPath
              ? [
                  {
                    width: 90,
                    stack: [
                      {
                        text: 'Scan to Pay',
                        fontSize: 7.5,
                        bold: true,
                        alignment: 'center',
                        color: INK,
                        margin: [0, 0, 0, 3],
                      },
                      {
                        image: qrPath,
                        fit: [80, 80],
                        width: 80,
                        alignment: 'center',
                      },
                      {
                        text: 'Google Pay / UPI',
                        fontSize: 6.5,
                        alignment: 'center',
                        color: SLATE,
                        margin: [0, 3, 0, 0],
                      },
                    ],
                  },
                ]
              : []),
            // Bank details + Dispatch Details (left column)
            {
              width: '*',
              stack: [
                {
                  text: 'Account Details',
                  fontSize: 9.5,
                  bold: true,
                  color: BLUE,
                  margin: [0, 0, 0, 5],
                },
                ...accountLines,
                // Dispatch Details below bank details
                {
                  canvas: [
                    {
                      type: 'line',
                      x1: 0,
                      y1: 0,
                      x2: 200,
                      y2: 0,
                      lineWidth: 0.5,
                      lineColor: RULE,
                    },
                  ],
                  margin: [0, 10, 0, 8],
                },
                {
                  text: 'Dispatch Details',
                  fontSize: 9.5,
                  bold: true,
                  color: BLUE,
                  margin: [0, 0, 0, 5],
                },
                ...[
                  ['Booking At', qBookingAt || '—'],
                  ['Goods Sent By', qGoodsSentBy || '—'],
                  ['Transport Payment By', qTransportPaymentBy || '—'],
                  ['Delivery Location', qDeliveryType || '—'],
                  ['Delivery Instruction', qDeliveryInstructions || '—'],
                ].map(([label, value]) => ({
                  columns: [
                    {
                      text: `${label}:`,
                      bold: true,
                      fontSize: 8,
                      width: 115,
                      color: INK,
                    },
                    {
                      text: breakLongWords(value) || value,
                      fontSize: 8,
                      width: '*',
                      color: value === '—' ? SLATE : '#374151',
                    },
                  ],
                  margin: [0, 0, 0, 3],
                })),
              ],
              margin: [qrPath ? 10 : 0, 0, 0, 0],
            },
            // Divider
            {
              width: 0.5,
              canvas: [
                {
                  type: 'line',
                  x1: 0,
                  y1: 0,
                  x2: 0,
                  y2: 220,
                  lineWidth: 0.5,
                  lineColor: '#aaa',
                },
              ],
            },
            // Totals
            {
              width: '42%',
              stack: totalsStack,
              margin: [10, 0, 0, 0],
            },
          ],
          columnGap: 8,
          margin: [0, 0, 0, 3],
        },

        // ── Terms & Conditions ───────────────────────────────────────────
        { text: termsText, fontSize: 6, margin: [0, 2, 0, 2], color: INK },

        // ── Computer Generated Notice ────────────────────────────────────
        {
          text: 'This is a Computer Generated Quotation, Signature & Seal not required.',
          fontSize: 7,
          italics: true,
          alignment: 'center',
          color: SLATE,
          margin: [0, 2, 0, 0],
        },
      ],
      styles: {
        th: { bold: true, fontSize: 8.5, color: '#fff', fillColor: BLUE },
        minorTitle: {
          fontSize: 7,
          bold: true,
          color: BLUE,
          letterSpacing: 0.2,
        },
      },
      defaultStyle: { fontSize: 8, font: 'Roboto' },
    };
  }

  orderTemplate(data: any): any {
    const BLUE = '#016bb2';
    const SLATE = '#64748b';
    const INK = '#0f172a';
    const RULE = '#cbd5e1';

    const safe = (v: any, fallback = '—') =>
      v != null && String(v).trim() !== '' ? String(v) : fallback;
    const inr = (n: any) =>
      `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const fmtDate = (dt: Date) => {
      const d = String(dt.getDate()).padStart(2, '0');
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      return `${d}/${m}/${dt.getFullYear()}`;
    };
    const today = fmtDate(new Date());
    const dateStr = (d: any) => {
      try {
        return d ? fmtDate(new Date(d)) : today;
      } catch {
        return today;
      }
    };

    const rows = Array.isArray(data?.items) ? data.items : [];
    // Tax mode is set per item now, not per document — show "Mixed" when
    // items disagree instead of a single (possibly wrong) document-wide label.
    const taxLabel =
      rows.length === 0
        ? data?.is_tax_inclusive
          ? '(Tax Incl.)'
          : '(Tax Extra)'
        : rows.every((it: any) => !!it?.is_tax_inclusive)
          ? '(Tax Incl.)'
          : rows.every((it: any) => !it?.is_tax_inclusive)
            ? '(Tax Extra)'
            : '(Mixed)';
    const companyName =
      appConfig?.companyName || 'Hesh Opto Lab Private Limited';
    const companyAddr =
      appConfig?.companyAddress ||
      'No. 207 / 208 / 209, Sri Selva Vinayagar Nagar, Alinjivakkam,\nRedhills, Chennai, Tamil Nadu, 600052';
    const companyPhone = appConfig?.companyPhone || '7010366206';
    const companyEmail =
      appConfig?.companyEmail || 'heshstoreaccounts@hotmail.com';
    const companyGstin = appConfig?.companyGstin || '33AABCH5436K1ZM';
    const bankAccName =
      appConfig?.bankAccountName || 'Hesh Opto Lab Private Limited';
    const bankName = appConfig?.bankName || 'Kotak Mahindra Bank';
    const bankBranch = appConfig?.bankBranch || 'Parrys Chennai';
    const bankAccount = appConfig?.bankAccount || '5811128721';
    const bankIfsc = appConfig?.bankIfsc || 'KKBK0000464';
    const companyPan = process.env.COMPANY_PAN || 'AABCH5436K';

    const subTotal = Number(data?.subtotal ?? data?.sub_total) || 0;
    const chargePack =
      Number(data?.packing_charges ?? data?.charges_packing) || 0;
    const chargeCar =
      Number(data?.cartage_charges ?? data?.charges_cartage) || 0;
    const chargeFwd =
      Number(data?.forwarding_charges ?? data?.charges_forwarding) || 0;
    const chargeInst =
      Number(data?.installation_charges ?? data?.charges_installation) || 0;
    const chargeLoad =
      Number(
        data?.charges_loading ||
          data?.loading_charges ||
          data?.loading_unloading,
      ) || 0;
    const roundOff =
      Number(data?.round_off ?? data?.roundoff ?? data?.roundOff) || 0;
    const gstByRate2 = new Map<number, number>();
    for (const it of rows) {
      const base = Number(it?.amount) || 0;
      const pct = Number(it?.gst_percent) || 0;
      const amt =
        it?.gst_amount != null ? Number(it.gst_amount) : (base * pct) / 100;
      if (pct > 0) gstByRate2.set(pct, (gstByRate2.get(pct) || 0) + amt);
    }
    const grandTotal = Number(data?.total_amount) || 0;

    const bookingAt = safe(data?.booking_at, '');
    const goodsSentBy = safe(data?.goods_sent_by, '');
    const transportPaymentBy = safe(
      data?.transport_payment_by || data?.payment_type || data?.payment_mode,
      '',
    );
    const deliveryInstructions = safe(
      data?.delivery_instructions || data?.transport,
      '',
    );
    const deliveryType = safe(data?.delivery_type, '');

    const orderNo = safe(
      data?.order_no || data?.order_number,
      `#${data?.id || '—'}`,
    );
    const salesPerson = safe(data?.salesman_name || data?.sales_person, '');
    const custName = safe(data?.customer_name, '');
    const custEmail = safe(data?.customer_email, '');
    const custPhone = safe(data?.customer_phone, '');
    const billAddr = safe(data?.billing_address, '');
    const shipAddr = safe(data?.shipping_address || data?.billing_address, '');
    const poNumber = safe(data?.po_number, '');
    const orderDate = dateStr(data?.created_at);
    const deliverDate =
      data?.due_date || data?.deliver_date
        ? dateStr(data.due_date || data.deliver_date)
        : '—';
    const quotationNo = safe(data?.quotation_no, '—');

    // (dispatch fields read above as bookingAt, goodsSentBy, transportPaymentBy, deliveryInstructions, deliveryType)

    // Logo + QR images
    const logoPath = this.resolveStaticImage('logo.png');
    const qrPath = this.resolveStaticImage('QR.jpg');

    // Items table: [S.No, Item Name, Instructions, Qty, Unit, [Disc], Rate, GST, Amount]
    // The Disc column only appears at all if at least one line item actually has a discount.
    const hasAnyDiscount = rows.some(
      (it: any) => Number(it?.discount_value) > 0,
    );
    const itemRows: any[] = rows.map((it: any, i: number) => {
      const base = Number(it?.amount) || 0;
      const gstPct = Number(it?.gst_percent) || 0;
      const discVal = Number(it?.discount_value) || 0;
      const disc =
        discVal > 0
          ? String(it?.discount_type || '').toLowerCase() === 'percent'
            ? `${discVal}%`
            : inr(discVal)
          : '';
      return [
        { text: String(i + 1), alignment: 'center', fontSize: 9 },
        {
          stack: [
            {
              text: safe(it?.item_name || it?.itemName, `Item ${i + 1}`),
              bold: true,
              fontSize: 9,
            },
            ...(it?.sku
              ? [{ text: String(it.sku), color: SLATE, fontSize: 7 }]
              : []),
          ],
        },
        {
          text: breakLongWords(
            safe(it?.instruction || it?.instructions || it?.notes, ''),
          ),
          fontSize: 8,
          color: SLATE,
        },
        {
          text: String(Number(it?.qty) || 0),
          alignment: 'center',
          fontSize: 9,
        },
        { text: safe(it?.unit || '', ''), alignment: 'center', fontSize: 9 },
        ...(hasAnyDiscount
          ? [{ text: disc, alignment: 'center', fontSize: 9 }]
          : []),
        { text: inr(it?.rate), alignment: 'right', fontSize: 9 },
        {
          text: gstPct > 0 ? `${gstPct}%` : '',
          alignment: 'center',
          fontSize: 9,
        },
        { text: inr(base), alignment: 'right', fontSize: 9, bold: true },
      ];
    });

    if (itemRows.length === 0) {
      const cols = hasAnyDiscount ? 9 : 8;
      itemRows.push([
        {
          text: 'No items',
          colSpan: cols,
          alignment: 'center',
          fontSize: 9,
          color: SLATE,
        },
        ...Array(cols - 1).fill({}),
      ]);
    }

    // Account details
    const bankRow2 = (label: string, value: string) => ({
      columns: [
        { text: label, bold: true, fontSize: 8, width: 110, color: INK },
        { text: value, fontSize: 8, width: '*', color: '#374151' },
      ],
      columnGap: 4,
      margin: [0, 0, 0, 3],
    });
    const accountLines: any[] = [
      bankRow2("Account Holder's Name:", bankAccName),
      bankRow2('Account Number:', bankAccount),
      bankRow2('Bank Name:', bankName),
      bankRow2('Branch Name:', bankBranch),
      bankRow2('IFSC Code:', bankIfsc),
    ];

    // Totals stack
    const tRow2 = (
      label: string,
      value: number,
      bold = false,
      large = false,
    ) => ({
      columns: [
        {
          text: label,
          fontSize: large ? 10 : 8.5,
          bold,
          color: large ? BLUE : INK,
          width: '*',
        },
        {
          text: inr(value),
          fontSize: large ? 10 : 8.5,
          bold,
          color: large ? BLUE : INK,
          width: 'auto',
          alignment: 'right',
        },
      ],
      margin: [0, large ? 2 : 1, 0, large ? 2 : 1],
    });
    const tDiv2 = () => ({
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 0,
          x2: 200,
          y2: 0,
          lineWidth: 0.5,
          lineColor: '#999',
        },
      ],
      margin: [0, 3, 0, 3],
    });
    const totalBeforeGst2 =
      subTotal + chargePack + chargeCar + chargeFwd + chargeInst + chargeLoad;
    const totalGstAmt2 = [...gstByRate2.values()].reduce((s, a) => s + a, 0);
    const computedGrandTotal2 = totalBeforeGst2 + totalGstAmt2 + roundOff;
    const totalsStack: any[] = [
      tRow2('Sub Total', subTotal, true, true),
      ...(chargePack > 0
        ? [tRow2('(+) Wooden Packing Charges', chargePack)]
        : []),
      ...(chargeCar > 0 ? [tRow2('(+) Cartage Charges', chargeCar)] : []),
      ...(chargeFwd > 0 ? [tRow2('(+) Forwarding Charges', chargeFwd)] : []),
      ...(chargeInst > 0
        ? [tRow2('(+) Onsite Installation Charges', chargeInst)]
        : []),
      ...(chargeLoad > 0
        ? [tRow2('(+) Loading & Unloading Charges', chargeLoad)]
        : []),
      tDiv2(),
      tRow2('Total', totalBeforeGst2, true, true),
      tDiv2(),
      ...[...gstByRate2.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([pct, amt]) =>
          tRow2(`(+) GST ${pct}% on ${inr((amt * 100) / pct)}`, amt),
        ),
      tDiv2(),
      tRow2('Rounded Off', roundOff),
      tDiv2(),
      tRow2('Grand Total', computedGrandTotal2, true, true),
      tDiv2(),
    ];

    const termsText =
      'TERMS & CONDITIONS\n' +
      '• Prices are valid only for this quotation and are subject to change without prior notice. ' +
      '• Order confirmation is subject to receipt of the agreed advance payment. ' +
      '• Delivery timelines commence only after advance payment and final order confirmation. ' +
      '• Any change in order specifications may affect pricing and delivery schedules. ' +
      '• Goods once sold will not be taken back except for approved manufacturing defects. ' +
      '• Risk in transit passes to the buyer upon dispatch. Transit damage claims must be made with the transporter. ' +
      '• Delivery delays due to force majeure or unforeseen circumstances shall not be the responsibility of the company. ' +
      '• Refunds, if approved, will be processed within 10 working days after verification. ' +
      '• GST and other applicable taxes will be charged as per prevailing rates on the invoice date. ' +
      '• Product specifications, prices, and designs are subject to change without prior notice. ' +
      '• All disputes shall be subject to the exclusive jurisdiction of the courts in Chennai, Tamil Nadu.';

    return {
      pageSize: 'A4',
      pageMargins: [36, 30, 36, 40],
      footer: (currentPage: number, pageCount: number) => ({
        margin: [36, 0, 36, 10],
        text: `Page ${currentPage}/${pageCount}`,
        fontSize: 8,
        italics: true,
        alignment: 'center',
        color: SLATE,
      }),
      content: [
        // ── Title ────────────────────────────────────────────────────────
        {
          text: 'Order Form',
          fontSize: 16,
          bold: true,
          alignment: 'center',
          margin: [0, 0, 0, 6],
        },

        // ── Header ──────────────────────────────────────────────────
        {
          columns: [
            {
              width: '*',
              stack: [
                {
                  text: companyName,
                  fontSize: 13,
                  bold: true,
                  margin: [0, 0, 0, 3],
                },
                {
                  text: companyAddr.replace(/\n/g, ', '),
                  fontSize: 7,
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    { text: 'Mobile: ', bold: true, fontSize: 7 },
                    { text: companyPhone, fontSize: 7, color: '#374151' },
                    { text: '     ·     ', fontSize: 7, color: SLATE },
                    { text: 'Email: ', bold: true, fontSize: 7 },
                    { text: companyEmail, fontSize: 7, color: '#374151' },
                  ],
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    { text: 'MSME Reg. No.: ', bold: true, fontSize: 7 },
                    {
                      text: 'UDYAM-TN-02-0034349',
                      fontSize: 7,
                      color: '#374151',
                    },
                  ],
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    {
                      text: 'ISO 9001 : 2015 Certified',
                      bold: true,
                      fontSize: 7,
                      color: BLUE,
                    },
                    { text: '  |  QMS System', fontSize: 7, color: SLATE },
                  ],
                  margin: [0, 0, 0, 2],
                },
                {
                  text: [
                    { text: 'GSTIN: ', bold: true, fontSize: 7.5 },
                    { text: companyGstin, bold: true, fontSize: 7.5 },
                  ],
                },
              ],
            },
            ...(logoPath
              ? [
                  {
                    image: logoPath,
                    fit: [152, 97],
                    width: 158,
                    alignment: 'right',
                  },
                ]
              : []),
          ],
          columnGap: 8,
          margin: [0, 0, 0, 8],
        },

        // ── Bill To / Ship To / Order Details ───────────────────────────
        (() => {
          const labelVal = (
            label: string,
            value: string,
            marginBottom = 5,
          ) => ({
            columns: [
              {
                text: label,
                bold: true,
                fontSize: 8,
                width: 'auto',
                color: INK,
              },
              {
                text: value,
                fontSize: 8,
                width: '*',
                color: '#374151',
                margin: [3, 0, 0, 0],
              },
            ],
            columnGap: 0,
            margin: [0, 0, 0, marginBottom],
          });

          const custPhone2 = safe(
            data?.customer_phone2 || data?.customer_mobile2,
            '',
          ).replace(/^\+91/, '');

          const partyStack = (addr: string) => {
            const { street, cityLine, stateLine } = splitAddressBlock(addr);
            return {
              stack: [
                {
                  text: custName.toUpperCase(),
                  fontSize: 9.5,
                  bold: true,
                  color: INK,
                  margin: [0, 0, 0, 3],
                },
                ...(street
                  ? [
                      {
                        text: street,
                        fontSize: 8,
                        color: '#374151',
                        lineHeight: 1.3,
                        margin: [0, 0, 0, 2],
                      },
                    ]
                  : []),
                ...(cityLine
                  ? [
                      {
                        text: cityLine,
                        fontSize: 8,
                        color: '#374151',
                        margin: [0, 0, 0, 2],
                      },
                    ]
                  : []),
                ...(stateLine
                  ? [
                      {
                        text: stateLine,
                        fontSize: 8,
                        color: '#374151',
                        margin: [0, 0, 0, 5],
                      },
                    ]
                  : []),
                ...(!street && !cityLine && !stateLine
                  ? [
                      {
                        text: '—',
                        fontSize: 8,
                        color: '#374151',
                        margin: [0, 0, 0, 5],
                      },
                    ]
                  : []),
                ...(custEmail
                  ? [
                      {
                        text: [
                          { text: 'Email: ', bold: true, fontSize: 8 },
                          { text: custEmail, fontSize: 8, color: '#374151' },
                        ],
                        margin: [0, 0, 0, 3],
                      },
                    ]
                  : []),
                ...(custPhone
                  ? [
                      {
                        text: [
                          { text: 'Mobile 1: ', bold: true, fontSize: 8 },
                          {
                            text: custPhone,
                            bold: true,
                            fontSize: 8,
                            color: INK,
                          },
                        ],
                        margin: [0, 0, 0, 3],
                      },
                    ]
                  : []),
                ...(custPhone2
                  ? [
                      {
                        text: [
                          { text: 'Mobile 2: ', bold: true, fontSize: 8 },
                          {
                            text: custPhone2,
                            bold: true,
                            fontSize: 8,
                            color: INK,
                          },
                        ],
                        margin: [0, 0, 0, 3],
                      },
                    ]
                  : []),
                {
                  canvas: [
                    {
                      type: 'line',
                      x1: 0,
                      y1: 0,
                      x2: 160,
                      y2: 0,
                      lineWidth: 0.4,
                      lineColor: RULE,
                    },
                  ],
                  margin: [0, 4, 0, 4],
                },
                {
                  text: [
                    { text: 'GSTIN: ', bold: true, fontSize: 8 },
                    {
                      text: safe(data?.gst_number, '') || 'URD',
                      bold: true,
                      fontSize: 8,
                      color: INK,
                    },
                  ],
                },
              ],
              margin: [6, 6, 6, 6],
            };
          };

          return {
            table: {
              widths: ['*', '*', '*'],
              body: [
                [
                  {
                    text: 'Bill To',
                    fontSize: 10,
                    bold: true,
                    color: '#fff',
                    fillColor: BLUE,
                    margin: [6, 4, 6, 4],
                  },
                  {
                    text: 'Ship To',
                    fontSize: 10,
                    bold: true,
                    color: '#fff',
                    fillColor: BLUE,
                    margin: [6, 4, 6, 4],
                  },
                  {
                    text: 'Order Details',
                    fontSize: 10,
                    bold: true,
                    color: '#fff',
                    fillColor: BLUE,
                    margin: [6, 4, 6, 4],
                  },
                ],
                [
                  partyStack(billAddr),
                  partyStack(shipAddr),
                  {
                    stack: [
                      labelVal('Date:', orderDate),
                      labelVal('Order No:', orderNo),
                      labelVal('Sales Man Name:', salesPerson || '—'),
                      labelVal('Ref Quotation No:', quotationNo),
                      {
                        canvas: [
                          {
                            type: 'line',
                            x1: 0,
                            y1: 0,
                            x2: 160,
                            y2: 0,
                            lineWidth: 0.4,
                            lineColor: RULE,
                          },
                        ],
                        margin: [0, 2, 0, 5],
                      },
                      labelVal('Payment Terms:', appConfig.paymentTerms),
                      labelVal('Delivery Date:', deliverDate),
                      // PO Document is deliberately not linked here — this template
                      // is shared by the downloadable PDF, and the WhatsApp/Email
                      // attachments generated from it, none of which can usefully
                      // carry a link back into the app. It's shown on the order's
                      // on-screen View page instead (OrderTemplate.js).
                      ...(poNumber
                        ? [labelVal('PO Number:', poNumber, 0)]
                        : []),
                    ],
                    margin: [5, 5, 5, 5],
                  },
                ],
              ],
            },
            layout: {
              hLineWidth: (i: number) =>
                i === 0 || i === 1 || i === 2 ? 0.5 : 0,
              vLineWidth: (i: number) =>
                i === 0 || i === 1 || i === 2 || i === 3 ? 0.5 : 0,
              hLineColor: () => RULE,
              vLineColor: () => RULE,
              paddingLeft: () => 0,
              paddingRight: () => 0,
              paddingTop: () => 0,
              paddingBottom: () => 0,
            },
            margin: [0, 0, 0, 8],
          };
        })(),

        // ── Items table ──────────────────────────────────────────────
        {
          table: {
            headerRows: 1,
            widths: [
              20,
              '*',
              58,
              20,
              26,
              ...(hasAnyDiscount ? [28] : []),
              48,
              24,
              50,
            ],
            body: [
              [
                { text: 'S.No', style: 'th', alignment: 'center' },
                { text: 'Item Name', style: 'th' },
                { text: 'Instructions', style: 'th' },
                { text: 'Qty', style: 'th', alignment: 'center' },
                { text: 'Unit', style: 'th', alignment: 'center' },
                ...(hasAnyDiscount
                  ? [{ text: 'Disc.', style: 'th', alignment: 'center' }]
                  : []),
                { text: 'Rate (₹)', style: 'th', alignment: 'right' },
                { text: 'GST Tax', style: 'th', alignment: 'center' },
                {
                  stack: [
                    {
                      text: 'Amount (₹)',
                      fontSize: 8.5,
                      bold: true,
                      color: '#fff',
                    },
                    {
                      text: taxLabel,
                      fontSize: 5.5,
                      color: '#fff',
                      italics: true,
                    },
                  ],
                  alignment: 'right',
                  fillColor: BLUE,
                },
              ],
              ...itemRows,
            ],
          },
          layout: {
            hLineWidth: (i: number, node: any) =>
              i === 0 ||
              i === node.table.headerRows ||
              i === node.table.body.length
                ? 1
                : 0.5,
            vLineWidth: () => 1,
            hLineColor: () => RULE,
            vLineColor: () => RULE,
            fillColor: (row: number) => (row === 0 ? BLUE : null),
            paddingLeft: () => 4,
            paddingRight: () => 4,
            paddingTop: () => 2,
            paddingBottom: () => 2,
          },
          margin: [0, 0, 0, 8],
        },

        // ── Account Details + QR | Totals ────────────────────────────────
        {
          columns: [
            // QR code
            ...(qrPath
              ? [
                  {
                    width: 90,
                    stack: [
                      {
                        text: 'Scan to Pay',
                        fontSize: 7.5,
                        bold: true,
                        alignment: 'center',
                        color: INK,
                        margin: [0, 0, 0, 3],
                      },
                      {
                        image: qrPath,
                        fit: [80, 80],
                        width: 80,
                        alignment: 'center',
                      },
                      {
                        text: 'Google Pay / UPI',
                        fontSize: 6.5,
                        alignment: 'center',
                        color: SLATE,
                        margin: [0, 3, 0, 0],
                      },
                    ],
                  },
                ]
              : []),
            // Bank details + Dispatch Details (left column)
            {
              width: '*',
              stack: [
                {
                  text: 'Account Details',
                  fontSize: 9.5,
                  bold: true,
                  color: BLUE,
                  margin: [0, 0, 0, 5],
                },
                ...accountLines,
                {
                  canvas: [
                    {
                      type: 'line',
                      x1: 0,
                      y1: 0,
                      x2: 200,
                      y2: 0,
                      lineWidth: 0.5,
                      lineColor: RULE,
                    },
                  ],
                  margin: [0, 10, 0, 8],
                },
                {
                  text: 'Dispatch Details',
                  fontSize: 9.5,
                  bold: true,
                  color: BLUE,
                  margin: [0, 0, 0, 5],
                },
                ...[
                  ['Booking At', bookingAt || '—'],
                  ['Goods Sent By', goodsSentBy || '—'],
                  ['Transport Payment By', transportPaymentBy || '—'],
                  ['Delivery Location', deliveryType || '—'],
                  ['Delivery Instruction', deliveryInstructions || '—'],
                ].map(([label, value]) => ({
                  columns: [
                    {
                      text: `${label}:`,
                      bold: true,
                      fontSize: 8,
                      width: 115,
                      color: INK,
                    },
                    {
                      text: breakLongWords(value) || value,
                      fontSize: 8,
                      width: '*',
                      color: value === '—' ? SLATE : '#374151',
                    },
                  ],
                  margin: [0, 0, 0, 3],
                })),
              ],
              margin: [qrPath ? 10 : 0, 0, 0, 0],
            },
            // Divider
            {
              width: 0.5,
              canvas: [
                {
                  type: 'line',
                  x1: 0,
                  y1: 0,
                  x2: 0,
                  y2: 220,
                  lineWidth: 0.5,
                  lineColor: '#aaa',
                },
              ],
            },
            // Totals
            {
              width: '42%',
              stack: totalsStack,
              margin: [10, 0, 0, 0],
            },
          ],
          columnGap: 8,
          margin: [0, 0, 0, 8],
        },

        // ── Terms & Conditions ───────────────────────────────────────
        { text: termsText, fontSize: 6, margin: [0, 6, 0, 6], color: INK },

        // ── Computer Generated Notice ─────────────────────────────────
        {
          text: 'This is a Computer Generated Order, Signature & Seal not required.',
          fontSize: 7.5,
          italics: true,
          alignment: 'center',
          color: SLATE,
          margin: [0, 4, 0, 0],
        },
      ],
      styles: {
        th: { bold: true, fontSize: 8.5, color: '#fff', fillColor: BLUE },
      },
      defaultStyle: { fontSize: 8, font: 'Roboto' },
    };
  }

  // ── Template: Invoice ────────────────────────────────────────────────────────

  invoiceTemplate(data: any): any {
    const BLUE = '#016bb2';
    const INK = '#0f172a';
    const RULE = '#cbd5e1';
    const safe = (v: any, fallback = '—') =>
      v != null && String(v).trim() !== '' ? String(v) : fallback;

    const custName = safe(data?.customer_name, '');
    const custPhone = safe(data?.customer_phone, '');
    const custPhone2 = safe(
      data?.customer_phone2 || data?.customer_mobile2,
      '',
    );
    const custEmail = safe(data?.customer_email, '');
    const billAddr = safe(data?.billing_address, '');
    const shipAddr = safe(data?.shipping_address || data?.billing_address, '');

    const partyStack = (addr: string) => {
      const { street, cityLine, stateLine } = splitAddressBlock(addr);
      return {
        stack: [
          {
            text: custName.toUpperCase(),
            fontSize: 9.5,
            bold: true,
            color: INK,
            margin: [0, 0, 0, 3],
          },
          ...(street
            ? [
                {
                  text: street,
                  fontSize: 8,
                  color: '#374151',
                  lineHeight: 1.3,
                  margin: [0, 0, 0, 2],
                },
              ]
            : []),
          ...(cityLine
            ? [
                {
                  text: cityLine,
                  fontSize: 8,
                  color: '#374151',
                  margin: [0, 0, 0, 2],
                },
              ]
            : []),
          ...(stateLine
            ? [
                {
                  text: stateLine,
                  fontSize: 8,
                  color: '#374151',
                  margin: [0, 0, 0, 5],
                },
              ]
            : []),
          ...(!street && !cityLine && !stateLine
            ? [
                {
                  text: '—',
                  fontSize: 8,
                  color: '#374151',
                  margin: [0, 0, 0, 5],
                },
              ]
            : []),
          ...(custEmail
            ? [
                {
                  text: [
                    { text: 'Email: ', bold: true, fontSize: 8 },
                    { text: custEmail, fontSize: 8, color: '#374151' },
                  ],
                  margin: [0, 0, 0, 3],
                },
              ]
            : []),
          ...(custPhone
            ? [
                {
                  text: [
                    { text: 'Mobile 1: ', bold: true, fontSize: 8 },
                    { text: custPhone, bold: true, fontSize: 8, color: INK },
                  ],
                  margin: [0, 0, 0, 3],
                },
              ]
            : []),
          ...(custPhone2
            ? [
                {
                  text: [
                    { text: 'Mobile 2: ', bold: true, fontSize: 8 },
                    { text: custPhone2, bold: true, fontSize: 8, color: INK },
                  ],
                  margin: [0, 0, 0, 3],
                },
              ]
            : []),
          {
            canvas: [
              {
                type: 'line',
                x1: 0,
                y1: 0,
                x2: 160,
                y2: 0,
                lineWidth: 0.4,
                lineColor: RULE,
              },
            ],
            margin: [0, 4, 0, 4],
          },
          {
            text: [
              { text: 'GSTIN: ', bold: true, fontSize: 8 },
              {
                text: safe(data?.gst_number, '') || 'URD',
                bold: true,
                fontSize: 8,
                color: INK,
              },
            ],
          },
        ],
        margin: [6, 6, 6, 6],
      };
    };

    const billShipTable = {
      table: {
        widths: ['*', '*'],
        body: [
          [
            {
              text: 'Bill To',
              fontSize: 10,
              bold: true,
              color: '#fff',
              fillColor: BLUE,
              margin: [6, 4, 6, 4],
            },
            {
              text: 'Ship To',
              fontSize: 10,
              bold: true,
              color: '#fff',
              fillColor: BLUE,
              margin: [6, 4, 6, 4],
            },
          ],
          [partyStack(billAddr), partyStack(shipAddr)],
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 || i === 1 || i === 2 ? 0.5 : 0),
        vLineWidth: (i: number) => (i === 0 || i === 1 || i === 2 ? 0.5 : 0),
        hLineColor: () => RULE,
        vLineColor: () => RULE,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
      margin: [0, 6, 0, 8],
    };

    const items = (Array.isArray(data?.items) ? data.items : []).map(
      (item: any, i: number) => [
        String(i + 1),
        item?.itemName || item?.item_name || '-',
        String(Number(item?.quantity) || 0),
        `₹${Number(item?.rate || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        `₹${Number(item?.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      ],
    );

    const ownershipLines = ownershipPdfStack(data, {
      showPhone: true,
      approvalPending:
        String(data?.order_status || data?.status || '').toUpperCase() ===
          'PENDING_APPROVAL' && !data?.approved_by_name,
    });

    return {
      content: [
        {
          text: 'Tax Invoice',
          fontSize: 18,
          bold: true,
          alignment: 'center',
          margin: [0, 0, 0, 8],
        },
        { text: appConfig?.companyName || 'Saachu', style: 'header' },
        {
          text: `INVOICE: ${data?.invoice_no || data?.id || ''}`,
          style: 'subheader',
        },
        billShipTable,
        ...(ownershipLines.length
          ? [{ stack: ownershipLines, margin: [0, 0, 0, 8] }]
          : []),
        {
          table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto', 'auto', 'auto'],
            body: [
              ['#', 'Item', 'Qty', 'Rate', 'Amount'],
              ...(items.length ? items : [['—', '—', '0', '—', '—']]),
            ],
          },
        },
        {
          text: `Sub Total: ₹${Number(data?.sub_total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          margin: [0, 8, 0, 2],
          alignment: 'right',
        },
        {
          text: `GST: ₹${Number((data?.cgst || 0) + (data?.sgst || 0) + (data?.igst || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          margin: [0, 0, 0, 2],
          alignment: 'right',
        },
        {
          text: `Total: ₹${Number(data?.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          style: 'total',
          margin: [0, 4, 0, 0],
        },
      ],
      styles: {
        header: { fontSize: 18, bold: true },
        subheader: { fontSize: 14, bold: true, margin: [0, 4, 0, 4] },
        total: { fontSize: 14, bold: true, alignment: 'right' },
      },
      defaultStyle: { font: 'Roboto' },
    };
  }

  // ── Core: generate PDF buffer ────────────────────────────────────────────────

  async generateBuffer(docDefinition: any): Promise<Buffer> {
    try {
      const doc = pdfmake.createPdf(docDefinition);
      return await doc.getBuffer();
    } catch (e: any) {
      this.logger.error(
        `[PDF ERROR] generateBuffer failed: ${e?.message}`,
        e?.stack,
      );
      throw new InternalServerErrorException(
        `PDF generation failed: ${e?.message || 'unknown error'}`,
      );
    }
  }

  // ── Core: generate + save to disk ────────────────────────────────────────────

  async generateAndSave(
    type: 'quotation' | 'order' | 'invoice',
    id: number,
    data: any,
  ): Promise<string> {
    let template: any;
    if (type === 'quotation') template = await this.quotationTemplate(data);
    else if (type === 'order') template = this.orderTemplate(data);
    else template = this.invoiceTemplate(data);

    const buffer = await this.generateBuffer(template);
    const dir = this.ensureUploadsDir();
    const filename = `${type}-${id}.pdf`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);
    return `/uploads/${filename}`;
  }
}
