import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { appConfig } from '../config/config';

// pdfmake v0.3 exports a singleton instance — not a constructor class.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfmake = require('pdfmake');

// Absolute paths to TTF files shipped inside the pdfmake package.
// process.cwd() is the project root (backend/), stable across src/ and dist/.
const FONT_DIR = path.join(process.cwd(), 'node_modules', 'pdfmake', 'fonts', 'Roboto');

try {
  pdfmake.setFonts({
    Roboto: {
      normal:      path.join(FONT_DIR, 'Roboto-Regular.ttf'),
      bold:        path.join(FONT_DIR, 'Roboto-Medium.ttf'),
      italics:     path.join(FONT_DIR, 'Roboto-Italic.ttf'),
      bolditalics: path.join(FONT_DIR, 'Roboto-MediumItalic.ttf'),
    },
  });
  // Allow pdfmake to read local TTF files from disk.
  pdfmake.setUrlAccessPolicy(() => true);
} catch (e: any) {
  new Logger('PdfService').error(`pdfmake font setup failed: ${e?.message}`);
}

const SLATE_OWN = '#64748b';

function ownershipPdfStack(data: any, opts?: { showPhone?: boolean; approvalPending?: boolean }) {
  const lines: any[] = [];
  const salesName = data?.salesman_name || data?.sales_person;
  if (salesName) {
    const parts = [salesName, data?.salesman_role, opts?.showPhone !== false ? data?.salesman_phone : null].filter(Boolean);
    lines.push({
      text: [{ text: 'Sales     ', bold: true, color: SLATE_OWN }, parts.join(' · ')],
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
      text: [{ text: 'Approved  ', bold: true, color: SLATE_OWN }, 'Pending Approval'],
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

  // ── Template: Quotation ──────────────────────────────────────────────────────

  quotationTemplate(data: any): any {
    const BLUE  = '#005fb8';
    const SLATE = '#64748b';
    const LIGHT = '#f1f5f9';
    const RULE  = '#94a3b8';
    const RED   = '#dc2626';

    const safe = (v: any, fallback = '—') =>
      (v != null && String(v).trim() !== '') ? String(v) : fallback;
    const inr  = (n: any) =>
      `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const date = (d: any) => {
      try { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
      catch { return '—'; }
    };

    // Amount in words
    const _ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
      'Seventeen', 'Eighteen', 'Nineteen'];
    const _tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const u100  = (n: number) =>
      n < 20 ? _ones[n] : _tens[Math.floor(n / 10)] + (n % 10 ? ' ' + _ones[n % 10] : '');
    const u1000 = (n: number) =>
      n < 100 ? u100(n) : _ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + u100(n % 100) : '');
    const amountInWords = (amount: number): string => {
      const n     = Math.floor(Math.abs(amount));
      const paise = Math.round((Math.abs(amount) - n) * 100);
      if (n === 0 && paise === 0) return 'Zero Rupees Only';
      const cr  = Math.floor(n / 10000000);
      const lk  = Math.floor((n % 10000000) / 100000);
      const th  = Math.floor((n % 100000) / 1000);
      const rem = n % 1000;
      let w = '';
      if (cr)  w += u1000(cr) + ' Crore ';
      if (lk)  w += u100(lk)  + ' Lakh ';
      if (th)  w += u100(th)  + ' Thousand ';
      if (rem) w += u1000(rem);
      w = w.trim() + ' Rupees';
      if (paise > 0) w += ' and ' + u100(paise) + ' Paise';
      return w + ' Only';
    };

    const rows         = Array.isArray(data?.items) ? data.items : [];
    const companyName  = safe(appConfig?.companyName,    'Saachu');
    const companyAddr  = safe(appConfig?.companyAddress, '');
    const companyPhone = safe(appConfig?.companyPhone,   '');
    const companyEmail = safe(appConfig?.companyEmail,   '');
    const companyWeb   = safe(appConfig?.companyWebsite, '');
    const companyGstin = safe(appConfig?.companyGstin,   '');
    const payTerms     = appConfig?.paymentTerms || '';
    const bankAccName  = appConfig?.bankAccountName || '';
    const bankName     = appConfig?.bankName        || '';
    const bankBranch   = appConfig?.bankBranch      || '';
    const bankAccount  = appConfig?.bankAccount     || '';
    const bankIfsc     = appConfig?.bankIfsc        || '';
    const bankUpi      = appConfig?.bankUpiId       || '';
    const hasBankInfo  = bankName || bankAccount || bankIfsc;

    // Financials
    const subTotal   = Number(data?.sub_total) || 0;
    const discType   = (data?.discount_type || 'PERCENT').toUpperCase();
    const discValue  = Number(data?.discount_value) || 0;
    const headerDisc = discType === 'FLAT' ? discValue : (subTotal * discValue) / 100;
    const taxable    = subTotal - headerDisc;
    const totalGst   = rows.reduce((s: number, it: any) => {
      const base = Number(it?.amount) || 0;
      const pct  = Number(it?.gst_percent) || 0;
      return s + (base * pct) / 100;
    }, 0);
    const cgst       = totalGst / 2;
    const sgst       = totalGst / 2;
    const chargePack = Number(data?.charges_packing)      || 0;
    const chargeCar  = Number(data?.charges_cartage)      || 0;
    const chargeFwd  = Number(data?.charges_forwarding)   || 0;
    const chargeInst = Number(data?.charges_installation) || 0;
    const chargeLoad = Number(data?.charges_loading)      || 0;
    const grandTotal = Number(data?.total_amount) || 0;

    // Items table (8 cols — Photo col omitted in PDF)
    const itemRows: any[] = rows.map((it: any, i: number) => {
      const base   = Number(it?.amount) || 0;
      const gstPct = Number(it?.gst_percent) || 0;
      const gstAmt = (base * gstPct) / 100;
      const total  = base + gstAmt;
      const disc   = it?.discount_percent
        ? `${it.discount_percent}%`
        : it?.discount_value
          ? inr(it.discount_value)
          : '—';
      return [
        { text: String(i + 1),                                                alignment: 'center', fontSize: 7.5 },
        {
          stack: [
            { text: safe(it?.item_name || it?.itemName, `Item ${i + 1}`),    bold: true, fontSize: 8 },
            ...(it?.sku ? [{ text: String(it.sku), color: SLATE, fontSize: 6.5 }] : []),
          ],
        },
        { text: safe(it?.instructions || it?.notes, '—'),                     fontSize: 7.5, color: SLATE },
        { text: gstPct > 0 ? `${gstPct}%` : '—',                             alignment: 'center', fontSize: 7.5 },
        { text: disc,                                                          alignment: 'center', fontSize: 7.5 },
        { text: String(Number(it?.qty) || 0),                                 alignment: 'center', fontSize: 7.5 },
        { text: inr(it?.rate),                                                 alignment: 'right',  fontSize: 7.5 },
        { text: inr(total),                                                    alignment: 'right',  fontSize: 7.5, bold: true },
      ];
    });

    if (itemRows.length === 0) {
      itemRows.push([
        { text: 'No items', colSpan: 8, alignment: 'center', fontSize: 8, color: SLATE },
        {}, {}, {}, {}, {}, {}, {},
      ]);
    }

    // Totals breakdown (right column)
    const totalRows: any[] = [
      [{ text: 'Sub Total', fontSize: 8 }, { text: inr(subTotal), alignment: 'right', fontSize: 8 }],
      ...(headerDisc > 0
        ? [[
            { text: discType === 'PERCENT' && discValue > 0 ? `Discount (${discValue}%)` : 'Discount', fontSize: 8, color: RED },
            { text: `−${inr(headerDisc)}`, alignment: 'right', fontSize: 8, color: RED },
          ]]
        : []),
      [{ text: 'Taxable Amount', fontSize: 8 }, { text: inr(taxable), alignment: 'right', fontSize: 8 }],
      ...(cgst > 0 ? [[{ text: 'CGST', fontSize: 8 }, { text: inr(cgst), alignment: 'right', fontSize: 8 }]] : []),
      ...(sgst > 0 ? [[{ text: 'SGST', fontSize: 8 }, { text: inr(sgst), alignment: 'right', fontSize: 8 }]] : []),
      ...(chargePack  > 0 ? [[{ text: 'Packing',      fontSize: 8 }, { text: inr(chargePack),  alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeCar   > 0 ? [[{ text: 'Cartage',      fontSize: 8 }, { text: inr(chargeCar),   alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeFwd   > 0 ? [[{ text: 'Forwarding',   fontSize: 8 }, { text: inr(chargeFwd),   alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeInst  > 0 ? [[{ text: 'Installation', fontSize: 8 }, { text: inr(chargeInst),  alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeLoad  > 0 ? [[{ text: 'Loading',      fontSize: 8 }, { text: inr(chargeLoad),  alignment: 'right', fontSize: 8 }]] : []),
      [
        { text: 'Grand Total', bold: true, fontSize: 10, color: '#fff', fillColor: BLUE },
        { text: inr(grandTotal), alignment: 'right', bold: true, fontSize: 10, color: '#fff', fillColor: BLUE },
      ],
    ];

    // Company info lines for header
    const coInfoLines: any[] = [
      { text: companyName, fontSize: 14, bold: true, color: BLUE },
    ];
    if (companyAddr)  coInfoLines.push({ text: companyAddr,  fontSize: 7.5, color: SLATE });
    const phoneEmail = [companyPhone, companyEmail].filter(Boolean).join('  ·  ');
    if (phoneEmail)   coInfoLines.push({ text: phoneEmail,   fontSize: 7.5, color: SLATE });
    if (companyWeb)   coInfoLines.push({ text: companyWeb,   fontSize: 7.5, color: SLATE });
    if (companyGstin) coInfoLines.push({ text: `GSTIN: ${companyGstin}`, fontSize: 7.5, color: SLATE, bold: true });

    // PI details (right col)
    const piStack: any[] = [
      { text: [{ text: 'PI No.  ', bold: true, color: SLATE }, safe(data?.quotation_no, '—')], fontSize: 8 },
      { text: [{ text: 'PI Date ', bold: true, color: SLATE }, date(data?.created_at)],        fontSize: 8 },
    ];
    if (data?.valid_till) piStack.push({ text: [{ text: 'Valid   ', bold: true, color: SLATE }, date(data.valid_till)], fontSize: 8 });
    piStack.push(...ownershipPdfStack(data, { showPhone: true, approvalPending: !data?.approved_by_name }));

    // Customer addresses
    const custName = safe(data?.customer_name, '—');
    const billAddr = [
      data?.billing_address,
      data?.gst_number     ? `GSTIN: ${data.gst_number}` : null,
      data?.customer_phone ? `Ph: ${data.customer_phone}` : null,
    ].filter(Boolean).join('\n');
    const shipAddr = safe(data?.shipping_address || data?.billing_address, '');

    // Delivery Details (3rd col)
    const deliveryStack: any[] = [
      { text: 'DELIVERY DETAILS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
    ];
    if (data?.booking_at) {
      deliveryStack.push({ text: [{ text: 'Booking At: ', bold: true }, safe(data.booking_at)], fontSize: 8 });
    }
    deliveryStack.push({ text: [{ text: 'Goods Sent By: ', bold: true }, safe(data?.delivery_by, '—')],  fontSize: 8, margin: [0, 1, 0, 0] });
    deliveryStack.push({ text: [{ text: 'Payment Mode: ',  bold: true }, safe(data?.payment_type, '—')], fontSize: 8, margin: [0, 1, 0, 0] });
    if (data?.delivery_instructions) {
      deliveryStack.push({ text: [{ text: 'Instructions: ', bold: true }, safe(data.delivery_instructions)], fontSize: 7.5, color: SLATE, margin: [0, 2, 0, 0] });
    }

    // Bank rows
    const bankRows: any[] = [];
    if (bankAccName) bankRows.push({ text: [{ text: 'Acc. Name: ', bold: true }, bankAccName], fontSize: 7.5 });
    if (bankName)    bankRows.push({ text: [{ text: 'Bank: ',      bold: true }, bankName],    fontSize: 7.5 });
    if (bankBranch)  bankRows.push({ text: [{ text: 'Branch: ',    bold: true }, bankBranch],  fontSize: 7.5 });
    if (bankAccount) bankRows.push({ text: [{ text: 'A/C No.: ',   bold: true }, bankAccount], fontSize: 7.5 });
    if (bankIfsc)    bankRows.push({ text: [{ text: 'IFSC: ',      bold: true }, bankIfsc],    fontSize: 7.5 });
    if (bankUpi)     bankRows.push({ text: [{ text: 'UPI: ',       bold: true }, bankUpi],     fontSize: 7.5 });
    if (bankRows.length === 0) bankRows.push({ text: 'Bank details not configured.', fontSize: 7.5, color: SLATE });

    return {
      pageSize: 'A4',
      pageMargins: [34, 34, 34, 34],
      content: [

        // ── Header ───────────────────────────────────────────────────────
        {
          columns: [
            { stack: coInfoLines, width: '*' },
            {
              stack: [{ text: 'PROFORMA INVOICE', fontSize: 12, bold: true, color: BLUE, alignment: 'center' }],
              width: 'auto',
              margin: [10, 0, 10, 0],
              border: [true, true, true, true],
            },
            { stack: piStack, width: 110, alignment: 'right' },
          ],
          margin: [0, 0, 0, 4],
        },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 1.5, lineColor: BLUE }], margin: [0, 0, 0, 5] },

        // ── 3-col: Bill To | Delivery To | Delivery Details ──────────────
        {
          table: {
            widths: ['*', '*', 105],
            body: [[
              {
                stack: [
                  { text: 'BILL TO', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 2] },
                  { text: custName, fontSize: 9, bold: true },
                  ...(billAddr ? [{ text: billAddr, fontSize: 7.5, color: SLATE, margin: [0, 1, 0, 0] }] : []),
                ],
              },
              {
                stack: [
                  { text: 'DELIVERY TO', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 2] },
                  { text: custName, fontSize: 9, bold: true },
                  ...(shipAddr ? [{ text: shipAddr, fontSize: 7.5, color: SLATE, margin: [0, 1, 0, 0] }] : []),
                ],
              },
              { stack: deliveryStack },
            ]],
          },
          layout: {
            hLineWidth: () => 0.5, vLineWidth: () => 0.5,
            hLineColor: () => RULE, vLineColor: () => RULE,
            paddingLeft: () => 6, paddingRight: () => 6,
            paddingTop:  () => 5, paddingBottom: () => 5,
          },
          margin: [0, 0, 0, 5],
        },

        // ── Items table (8 cols — Photo omitted in PDF) ───────────────────
        {
          table: {
            headerRows: 1,
            widths: [14, '*', 62, 22, 28, 22, 45, 46],
            body: [
              [
                { text: '#',             style: 'th', alignment: 'center' },
                { text: 'Item No / Name',style: 'th' },
                { text: 'Instructions',  style: 'th' },
                { text: 'GST%',          style: 'th', alignment: 'center' },
                { text: 'Disc.',         style: 'th', alignment: 'center' },
                { text: 'Qty',           style: 'th', alignment: 'center' },
                { text: 'Rate (₹)',      style: 'th', alignment: 'right'  },
                { text: 'Amount (₹)',    style: 'th', alignment: 'right'  },
              ],
              ...itemRows,
            ],
          },
          layout: {
            hLineWidth: (i: number, node: any) =>
              (i === 0 || i === node.table.headerRows || i === node.table.body.length) ? 0.75 : 0.35,
            vLineWidth: () => 0,
            hLineColor: (i: number) => i === 0 ? BLUE : RULE,
            fillColor:  (row: number) => row === 0 ? BLUE : (row % 2 === 0 ? LIGHT : null),
            paddingLeft: () => 3, paddingRight: () => 3,
            paddingTop:  () => 3, paddingBottom: () => 3,
          },
          margin: [0, 0, 0, 5],
        },

        // ── Totals: Amount in Words | Breakdown ───────────────────────────
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: 'AMOUNT IN WORDS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
                { text: amountInWords(grandTotal), fontSize: 8.5, italics: true },
              ],
              margin: [0, 4, 10, 0],
            },
            {
              width: 175,
              table: { widths: ['*', 'auto'], body: totalRows },
              layout: {
                hLineWidth: (i: number, node: any) =>
                  (i === node.table.body.length - 1 || i === node.table.body.length) ? 0 : 0.35,
                vLineWidth: () => 0,
                hLineColor: () => RULE,
                paddingLeft: () => 4, paddingRight: () => 4,
                paddingTop:  () => 3, paddingBottom: () => 3,
              },
            },
          ],
          margin: [0, 0, 0, 8],
        },

        // ── Payment Terms Bar ─────────────────────────────────────────────
        ...(payTerms ? [{
          table: {
            widths: ['*'],
            body: [[{
              stack: [
                { text: 'PAYMENT TERMS', fontSize: 7, bold: true, color: BLUE, alignment: 'center', margin: [0, 0, 0, 2] },
                { text: payTerms,         fontSize: 9, bold: true, color: BLUE, alignment: 'center' },
              ],
              margin: [0, 4, 0, 4],
            }]],
          },
          layout: {
            hLineWidth: () => 1, vLineWidth: () => 1,
            hLineColor: () => BLUE, vLineColor: () => BLUE,
          },
          margin: [0, 0, 0, 8],
        }] : []),

        // ── Rule before bottom grid ───────────────────────────────────────
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 0, 0, 5] },

        // ── Bottom 2-col: Bank | T&C ──────────────────────────────────────
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: 'BANK DETAILS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
                ...bankRows,
              ],
            },
            {
              width: '*',
              stack: [
                { text: 'TERMS & CONDITIONS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
                {
                  ol: [
                    'All disputes are subject to Chennai jurisdiction only.',
                    'Payment as per agreed terms. Goods remain property of seller until full payment received.',
                    'Delivery charges and risks are borne by the buyer unless otherwise agreed.',
                    'Transport / freight charges are additional unless explicitly included in this quotation.',
                    'Prices are subject to change without prior notice for delayed orders. E.&O.E.',
                  ],
                  fontSize: 7.5,
                  color: SLATE,
                },
              ],
            },
          ],
          margin: [0, 0, 0, 10],
        },

        // ── Computer-generated line ───────────────────────────────────────
        {
          text: 'This is a Computer Generated Quotation',
          fontSize: 7.5, italics: true, color: SLATE, alignment: 'center',
          margin: [0, 0, 0, 6],
        },

        // ── Footer ────────────────────────────────────────────────────────
        {
          columns: [
            { text: 'Thank you for your business!', fontSize: 8, bold: true, color: BLUE },
            { text: 'Page 1 of 1', fontSize: 7.5, color: SLATE, alignment: 'right' },
          ],
        },
      ],
      styles: {
        th: { bold: true, fontSize: 8, color: '#fff', fillColor: BLUE },
      },
      defaultStyle: { fontSize: 8.5, font: 'Roboto' },
    };
  }

  // ── Template: Order ──────────────────────────────────────────────────────────

  orderTemplate(data: any): any {
    const BLUE  = '#005fb8';
    const SLATE = '#64748b';
    const LIGHT = '#f1f5f9';
    const RULE  = '#94a3b8';
    const RED   = '#dc2626';
    const GREEN = '#15803d';

    const safe = (v: any, fallback = '—') =>
      (v != null && String(v).trim() !== '') ? String(v) : fallback;
    const inr  = (n: any) =>
      `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const date = (d: any) => {
      try { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
      catch { return '—'; }
    };

    // Shared amount-in-words (same as quotationTemplate)
    const _ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
      'Seventeen', 'Eighteen', 'Nineteen'];
    const _tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const u100  = (n: number) =>
      n < 20 ? _ones[n] : _tens[Math.floor(n / 10)] + (n % 10 ? ' ' + _ones[n % 10] : '');
    const u1000 = (n: number) =>
      n < 100 ? u100(n) : _ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + u100(n % 100) : '');
    const amountInWords = (amount: number): string => {
      const n     = Math.floor(Math.abs(amount));
      const paise = Math.round((Math.abs(amount) - n) * 100);
      if (n === 0 && paise === 0) return 'Zero Rupees Only';
      const cr  = Math.floor(n / 10000000);
      const lk  = Math.floor((n % 10000000) / 100000);
      const th  = Math.floor((n % 100000) / 1000);
      const rem = n % 1000;
      let w = '';
      if (cr)  w += u1000(cr) + ' Crore ';
      if (lk)  w += u100(lk)  + ' Lakh ';
      if (th)  w += u100(th)  + ' Thousand ';
      if (rem) w += u1000(rem);
      w = w.trim() + ' Rupees';
      if (paise > 0) w += ' and ' + u100(paise) + ' Paise';
      return w + ' Only';
    };

    const rows = Array.isArray(data?.items) ? data.items : [];

    // Order entity uses different field names from quotation
    const companyName  = safe(appConfig?.companyName,    'Saachu');
    const companyAddr  = safe(appConfig?.companyAddress, '');
    const companyPhone = safe(appConfig?.companyPhone,   '');
    const companyEmail = safe(appConfig?.companyEmail,   '');
    const companyWeb   = safe(appConfig?.companyWebsite, '');
    const companyGstin = safe(appConfig?.companyGstin,   '');
    const payTerms     = appConfig?.paymentTerms || '';
    const bankAccName  = appConfig?.bankAccountName || '';
    const bankName     = appConfig?.bankName        || '';
    const bankBranch   = appConfig?.bankBranch      || '';
    const bankAccount  = appConfig?.bankAccount     || '';
    const bankIfsc     = appConfig?.bankIfsc        || '';
    const bankUpi      = appConfig?.bankUpiId       || '';

    // Order-specific field aliases
    const subTotal   = Number(data?.subtotal ?? data?.sub_total) || 0;
    const discType   = (data?.discount_type || 'PERCENT').toUpperCase();
    const discValue  = Number(data?.discount_value) || 0;
    const headerDisc = discType === 'FLAT' ? discValue : (subTotal * discValue) / 100;
    const taxable    = subTotal - headerDisc;
    const totalGst   = rows.reduce((s: number, it: any) => {
      const base = Number(it?.amount) || 0;
      const pct  = Number(it?.gst_percent) || 0;
      return s + (it?.gst_amount != null ? Number(it.gst_amount) : (base * pct) / 100);
    }, 0);
    const cgst        = totalGst / 2;
    const sgst        = totalGst / 2;
    const chargePack  = Number(data?.packing_charges      ?? data?.charges_packing)      || 0;
    const chargeCar   = Number(data?.cartage_charges      ?? data?.charges_cartage)      || 0;
    const chargeFwd   = Number(data?.forwarding_charges   ?? data?.charges_forwarding)   || 0;
    const chargeInst  = Number(data?.installation_charges ?? data?.charges_installation) || 0;
    const chargeLoad  = Number(data?.loading_charges      ?? data?.charges_loading)      || 0;
    const grandTotal  = Number(data?.total_amount) || 0;
    const paidAmount  = Number(data?.paid_amount)  || 0;
    const pendingAmt  = Number(data?.pending_amount ?? (grandTotal - paidAmount));
    const orderNo     = safe(data?.order_no || data?.order_number, `#${data?.id || '—'}`);

    // Status badge
    const STATUS_LABEL: Record<string, string> = {
      PENDING_APPROVAL: 'Pending Approval', APPROVED: 'Approved',
      REJECTED: 'Rejected', IN_PRODUCTION: 'In Production',
      READY_FOR_DISPATCH: 'Ready for Dispatch', DISPATCHED: 'Dispatched',
      COMPLETED: 'Completed', CANCELLED: 'Cancelled',
    };
    const STATUS_BG: Record<string, string> = {
      APPROVED: '#d1fae5', REJECTED: '#fee2e2', CANCELLED: '#fee2e2',
      IN_PRODUCTION: '#dbeafe', PENDING_APPROVAL: '#fff7ed',
    };
    const statusText = STATUS_LABEL[data?.status] || data?.status || '';
    const statusBg   = STATUS_BG[data?.status]   || LIGHT;

    // Items table (8 cols — Photo omitted in PDF)
    const itemRows: any[] = rows.map((it: any, i: number) => {
      const base   = Number(it?.amount) || 0;
      const gstPct = Number(it?.gst_percent) || 0;
      const gstAmt = it?.gst_amount != null ? Number(it.gst_amount) : (base * gstPct) / 100;
      const total  = base + gstAmt;
      const discVal = Number(it?.discount_value) || 0;
      const disc    = discVal > 0
        ? (String(it?.discount_type || '').toLowerCase() === 'percent' ? `${discVal}%` : inr(discVal))
        : '—';
      return [
        { text: String(i + 1),                                                alignment: 'center', fontSize: 7.5 },
        {
          stack: [
            { text: safe(it?.item_name || it?.itemName, `Item ${i + 1}`),    bold: true, fontSize: 8 },
            ...(it?.sku ? [{ text: String(it.sku), color: SLATE, fontSize: 6.5 }] : []),
          ],
        },
        { text: safe(it?.instruction || it?.instructions || it?.notes, '—'), fontSize: 7.5, color: SLATE },
        { text: gstPct > 0 ? `${gstPct}%` : '—',                             alignment: 'center', fontSize: 7.5 },
        { text: disc,                                                          alignment: 'center', fontSize: 7.5 },
        { text: String(Number(it?.qty) || 0),                                 alignment: 'center', fontSize: 7.5 },
        { text: inr(it?.rate),                                                 alignment: 'right',  fontSize: 7.5 },
        { text: inr(total),                                                    alignment: 'right',  fontSize: 7.5, bold: true },
      ];
    });

    if (itemRows.length === 0) {
      itemRows.push([
        { text: 'No items', colSpan: 8, alignment: 'center', fontSize: 8, color: SLATE },
        {}, {}, {}, {}, {}, {}, {},
      ]);
    }

    // Totals breakdown
    const totalRows: any[] = [
      [{ text: 'Sub Total', fontSize: 8 }, { text: inr(subTotal), alignment: 'right', fontSize: 8 }],
      ...(headerDisc > 0 ? [[
        { text: discType === 'PERCENT' && discValue > 0 ? `Discount (${discValue}%)` : 'Discount', fontSize: 8, color: RED },
        { text: `−${inr(headerDisc)}`, alignment: 'right', fontSize: 8, color: RED },
      ]] : []),
      [{ text: 'Taxable Amount', fontSize: 8 }, { text: inr(taxable), alignment: 'right', fontSize: 8 }],
      ...(cgst > 0 ? [[{ text: 'CGST', fontSize: 8 }, { text: inr(cgst), alignment: 'right', fontSize: 8 }]] : []),
      ...(sgst > 0 ? [[{ text: 'SGST', fontSize: 8 }, { text: inr(sgst), alignment: 'right', fontSize: 8 }]] : []),
      ...(chargePack  > 0 ? [[{ text: 'Packing',      fontSize: 8 }, { text: inr(chargePack),  alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeCar   > 0 ? [[{ text: 'Cartage',      fontSize: 8 }, { text: inr(chargeCar),   alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeFwd   > 0 ? [[{ text: 'Forwarding',   fontSize: 8 }, { text: inr(chargeFwd),   alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeInst  > 0 ? [[{ text: 'Installation', fontSize: 8 }, { text: inr(chargeInst),  alignment: 'right', fontSize: 8 }]] : []),
      ...(chargeLoad  > 0 ? [[{ text: 'Loading',      fontSize: 8 }, { text: inr(chargeLoad),  alignment: 'right', fontSize: 8 }]] : []),
      [
        { text: 'Grand Total', bold: true, fontSize: 10, color: '#fff', fillColor: BLUE },
        { text: inr(grandTotal), alignment: 'right', bold: true, fontSize: 10, color: '#fff', fillColor: BLUE },
      ],
    ];

    // Company info lines
    const coInfoLines: any[] = [
      { text: companyName, fontSize: 14, bold: true, color: BLUE },
    ];
    if (companyAddr)  coInfoLines.push({ text: companyAddr,  fontSize: 7.5, color: SLATE });
    const phoneEmail = [companyPhone, companyEmail].filter(Boolean).join('  ·  ');
    if (phoneEmail)   coInfoLines.push({ text: phoneEmail,   fontSize: 7.5, color: SLATE });
    if (companyWeb)   coInfoLines.push({ text: companyWeb,   fontSize: 7.5, color: SLATE });
    if (companyGstin) coInfoLines.push({ text: `GSTIN: ${companyGstin}`, fontSize: 7.5, color: SLATE, bold: true });

    // Order details (right col)
    const detailStack: any[] = [
      { text: [{ text: 'Order No.  ', bold: true, color: SLATE }, orderNo],          fontSize: 8 },
      { text: [{ text: 'Order Date ', bold: true, color: SLATE }, date(data?.created_at)], fontSize: 8 },
    ];
    if (data?.due_date) detailStack.push({ text: [{ text: 'Exp. Delivery ', bold: true, color: SLATE }, date(data.due_date)], fontSize: 8 });
    const orderPending =
      String(data?.status || '').toUpperCase() === 'PENDING_APPROVAL' ||
      String(data?.status || '').toUpperCase() === 'GENERATED';
    detailStack.push(
      ...ownershipPdfStack(data, {
        showPhone: true,
        approvalPending: orderPending && !data?.approved_by_name,
      }),
    );
    if (statusText)           detailStack.push({ text: statusText, fontSize: 7.5, bold: true, color: '#fff', background: statusBg, margin: [0, 3, 0, 0] });

    // Customer addresses
    const custName = safe(data?.customer_name, '—');
    const billAddr = [
      data?.billing_address,
      data?.gst_number      ? `GSTIN: ${data.gst_number}` : null,
      data?.customer_phone  ? `Ph: ${data.customer_phone}` : null,
    ].filter(Boolean).join('\n');
    const shipAddr = safe(data?.shipping_address || data?.billing_address, '');

    // Delivery details (3rd col)
    const delivStack: any[] = [
      { text: 'DELIVERY DETAILS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
    ];
    if (data?.due_date)     delivStack.push({ text: [{ text: 'Exp. Dispatch: ', bold: true }, date(data.due_date)], fontSize: 8 });
    delivStack.push({ text: [{ text: 'Dispatch Type: ', bold: true }, safe(data?.delivery_type, '—')], fontSize: 8, margin: [0, 1, 0, 0] });
    delivStack.push({ text: [{ text: 'Goods Sent By: ', bold: true }, safe(data?.delivery_by, '—')],  fontSize: 8, margin: [0, 1, 0, 0] });
    delivStack.push({ text: [{ text: 'Payment Mode: ', bold: true }, safe(data?.payment_type || data?.payment_mode, '—')], fontSize: 8, margin: [0, 1, 0, 0] });
    if (data?.delivery_instructions) {
      delivStack.push({ text: [{ text: 'Instructions: ', bold: true }, safe(data.delivery_instructions)], fontSize: 7.5, color: SLATE, margin: [0, 2, 0, 0] });
    }

    // Bank rows
    const bankRows: any[] = [];
    if (bankAccName) bankRows.push({ text: [{ text: 'Acc. Name: ', bold: true }, bankAccName], fontSize: 7.5 });
    if (bankName)    bankRows.push({ text: [{ text: 'Bank: ',      bold: true }, bankName],    fontSize: 7.5 });
    if (bankBranch)  bankRows.push({ text: [{ text: 'Branch: ',    bold: true }, bankBranch],  fontSize: 7.5 });
    if (bankAccount) bankRows.push({ text: [{ text: 'A/C No.: ',   bold: true }, bankAccount], fontSize: 7.5 });
    if (bankIfsc)    bankRows.push({ text: [{ text: 'IFSC: ',      bold: true }, bankIfsc],    fontSize: 7.5 });
    if (bankUpi)     bankRows.push({ text: [{ text: 'UPI: ',       bold: true }, bankUpi],     fontSize: 7.5 });
    if (bankRows.length === 0) bankRows.push({ text: 'Bank details not configured.', fontSize: 7.5, color: SLATE });

    // Payment status section (orders only)
    const hasPayment = paidAmount > 0 || pendingAmt > 0;
    const payStatusSection: any[] = hasPayment ? [{
      table: {
        widths: ['*', '*', '*'],
        body: [[
          {
            stack: [
              { text: 'GRAND TOTAL', fontSize: 7, bold: true, color: SLATE, alignment: 'center' },
              { text: inr(grandTotal), fontSize: 10, bold: true, color: BLUE, alignment: 'center' },
            ],
            margin: [0, 4, 0, 4],
          },
          {
            stack: [
              { text: 'ADVANCE RECEIVED', fontSize: 7, bold: true, color: SLATE, alignment: 'center' },
              { text: inr(paidAmount), fontSize: 10, bold: true, color: GREEN, alignment: 'center' },
            ],
            margin: [0, 4, 0, 4],
          },
          {
            stack: [
              { text: 'BALANCE DUE', fontSize: 7, bold: true, color: SLATE, alignment: 'center' },
              { text: inr(pendingAmt), fontSize: 10, bold: true, color: pendingAmt > 0 ? RED : GREEN, alignment: 'center' },
            ],
            margin: [0, 4, 0, 4],
          },
        ]],
      },
      layout: {
        hLineWidth: () => 0.5, vLineWidth: () => 0.5,
        hLineColor: () => RULE, vLineColor: () => RULE,
        fillColor: () => LIGHT,
      },
      margin: [0, 0, 0, 8],
    }] : [];

    return {
      pageSize: 'A4',
      pageMargins: [34, 34, 34, 34],
      content: [

        // ── Header ──────────────────────────────────────────────────
        {
          columns: [
            { stack: coInfoLines, width: '*' },
            {
              stack: [{ text: 'ORDER CONFIRMATION', fontSize: 12, bold: true, color: BLUE, alignment: 'center' }],
              width: 'auto', margin: [10, 0, 10, 0],
            },
            { stack: detailStack, width: 110, alignment: 'right' },
          ],
          margin: [0, 0, 0, 4],
        },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 1.5, lineColor: BLUE }], margin: [0, 0, 0, 5] },

        // ── 3-col: Bill To | Delivery To | Delivery Details ──────────
        {
          table: {
            widths: ['*', '*', 105],
            body: [[
              {
                stack: [
                  { text: 'BILL TO', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 2] },
                  { text: custName, fontSize: 9, bold: true },
                  ...(billAddr ? [{ text: billAddr, fontSize: 7.5, color: SLATE, margin: [0, 1, 0, 0] }] : []),
                ],
              },
              {
                stack: [
                  { text: 'DELIVERY TO', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 2] },
                  { text: custName, fontSize: 9, bold: true },
                  ...(shipAddr ? [{ text: shipAddr, fontSize: 7.5, color: SLATE, margin: [0, 1, 0, 0] }] : []),
                ],
              },
              { stack: delivStack },
            ]],
          },
          layout: {
            hLineWidth: () => 0.5, vLineWidth: () => 0.5,
            hLineColor: () => RULE, vLineColor: () => RULE,
            paddingLeft: () => 6, paddingRight: () => 6,
            paddingTop:  () => 5, paddingBottom: () => 5,
          },
          margin: [0, 0, 0, 5],
        },

        // ── Items table ──────────────────────────────────────────────
        {
          table: {
            headerRows: 1,
            widths: [14, '*', 62, 22, 28, 22, 45, 46],
            body: [
              [
                { text: '#',              style: 'th', alignment: 'center' },
                { text: 'Item No / Name', style: 'th' },
                { text: 'Instructions',   style: 'th' },
                { text: 'GST%',           style: 'th', alignment: 'center' },
                { text: 'Disc.',          style: 'th', alignment: 'center' },
                { text: 'Qty',            style: 'th', alignment: 'center' },
                { text: 'Rate (₹)',       style: 'th', alignment: 'right'  },
                { text: 'Amount (₹)',     style: 'th', alignment: 'right'  },
              ],
              ...itemRows,
            ],
          },
          layout: {
            hLineWidth: (i: number, node: any) =>
              (i === 0 || i === node.table.headerRows || i === node.table.body.length) ? 0.75 : 0.35,
            vLineWidth: () => 0,
            hLineColor: (i: number) => i === 0 ? BLUE : RULE,
            fillColor:  (row: number) => row === 0 ? BLUE : (row % 2 === 0 ? LIGHT : null),
            paddingLeft: () => 3, paddingRight: () => 3,
            paddingTop:  () => 3, paddingBottom: () => 3,
          },
          margin: [0, 0, 0, 5],
        },

        // ── Totals: Amount in Words | Breakdown ──────────────────────
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: 'AMOUNT IN WORDS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
                { text: amountInWords(grandTotal), fontSize: 8.5, italics: true },
              ],
              margin: [0, 4, 10, 0],
            },
            {
              width: 175,
              table: { widths: ['*', 'auto'], body: totalRows },
              layout: {
                hLineWidth: (i: number, node: any) =>
                  (i === node.table.body.length - 1 || i === node.table.body.length) ? 0 : 0.35,
                vLineWidth: () => 0,
                hLineColor: () => RULE,
                paddingLeft: () => 4, paddingRight: () => 4,
                paddingTop:  () => 3, paddingBottom: () => 3,
              },
            },
          ],
          margin: [0, 0, 0, 8],
        },

        // ── Payment Status (if any payments recorded) ────────────────
        ...payStatusSection,

        // ── Payment Terms Bar ────────────────────────────────────────
        ...(payTerms ? [{
          table: {
            widths: ['*'],
            body: [[{
              stack: [
                { text: 'PAYMENT TERMS', fontSize: 7, bold: true, color: BLUE, alignment: 'center', margin: [0, 0, 0, 2] },
                { text: payTerms, fontSize: 9, bold: true, color: BLUE, alignment: 'center' },
              ],
              margin: [0, 4, 0, 4],
            }]],
          },
          layout: {
            hLineWidth: () => 1, vLineWidth: () => 1,
            hLineColor: () => BLUE, vLineColor: () => BLUE,
          },
          margin: [0, 0, 0, 8],
        }] : []),

        // ── Rule before bottom ───────────────────────────────────────
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 0, 0, 5] },

        // ── Bottom 2-col: Bank | T&C ─────────────────────────────────
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: 'BANK DETAILS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
                ...bankRows,
              ],
            },
            {
              width: '*',
              stack: [
                { text: 'TERMS & CONDITIONS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 3] },
                {
                  ol: [
                    'All disputes are subject to Chennai jurisdiction only.',
                    'Payment as per agreed terms. Goods remain property of seller until full payment received.',
                    'Delivery charges and risks are borne by the buyer unless otherwise agreed.',
                    'Transport / freight charges are additional unless explicitly included in this order.',
                    'Prices are subject to change without prior notice for delayed orders. E.&O.E.',
                  ],
                  fontSize: 7.5, color: SLATE,
                },
              ],
            },
          ],
          margin: [0, 0, 0, 10],
        },

        // ── Computer-generated line ──────────────────────────────────
        {
          text: 'This is a Computer Generated Order Confirmation',
          fontSize: 7.5, italics: true, color: SLATE, alignment: 'center',
          margin: [0, 0, 0, 6],
        },

        // ── Footer ───────────────────────────────────────────────────
        {
          columns: [
            { text: 'Thank you for your order!', fontSize: 8, bold: true, color: BLUE },
            { text: 'Page 1 of 1', fontSize: 7.5, color: SLATE, alignment: 'right' },
          ],
        },
      ],
      styles: {
        th: { bold: true, fontSize: 8, color: '#fff', fillColor: BLUE },
      },
      defaultStyle: { fontSize: 8.5, font: 'Roboto' },
    };
  }

  // ── Template: Invoice ────────────────────────────────────────────────────────

  invoiceTemplate(data: any): any {
    const items = (Array.isArray(data?.items) ? data.items : []).map((item: any, i: number) => [
      String(i + 1),
      item?.itemName || item?.item_name || '-',
      String(Number(item?.quantity) || 0),
      `₹${Number(item?.rate || 0).toFixed(2)}`,
      `₹${Number(item?.amount || 0).toFixed(2)}`,
    ]);

    const ownershipLines = ownershipPdfStack(data, {
      showPhone: true,
      approvalPending:
        String(data?.order_status || data?.status || '').toUpperCase() === 'PENDING_APPROVAL' &&
        !data?.approved_by_name,
    });

    return {
      content: [
        { text: appConfig?.companyName || 'Saachu', style: 'header' },
        { text: `INVOICE: ${data?.invoice_no || data?.id || ''}`, style: 'subheader' },
        { text: `Customer: ${data?.customer_name || ''}`, margin: [0, 4, 0, 2] },
        ...(ownershipLines.length ? [{ stack: ownershipLines, margin: [0, 0, 0, 8] }] : []),
        {
          table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto', 'auto', 'auto'],
            body: [['#', 'Item', 'Qty', 'Rate', 'Amount'], ...(items.length ? items : [['—', '—', '0', '—', '—']])],
          },
        },
        { text: `Sub Total: ₹${Number(data?.sub_total || 0).toFixed(2)}`, margin: [0, 8, 0, 2], alignment: 'right' },
        { text: `GST: ₹${Number((data?.cgst || 0) + (data?.sgst || 0) + (data?.igst || 0)).toFixed(2)}`, margin: [0, 0, 0, 2], alignment: 'right' },
        { text: `Total: ₹${Number(data?.total_amount || 0).toFixed(2)}`, style: 'total', margin: [0, 4, 0, 0] },
      ],
      styles: {
        header:    { fontSize: 18, bold: true },
        subheader: { fontSize: 14, bold: true, margin: [0, 4, 0, 4] },
        total:     { fontSize: 14, bold: true, alignment: 'right' },
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
      this.logger.error(`[PDF ERROR] generateBuffer failed: ${e?.message}`, e?.stack);
      throw new InternalServerErrorException(`PDF generation failed: ${e?.message || 'unknown error'}`);
    }
  }

  // ── Core: generate + save to disk ────────────────────────────────────────────

  async generateAndSave(type: 'quotation' | 'order' | 'invoice', id: number, data: any): Promise<string> {
    let template: any;
    if (type === 'quotation')     template = this.quotationTemplate(data);
    else if (type === 'order')    template = this.orderTemplate(data);
    else                          template = this.invoiceTemplate(data);

    const buffer   = await this.generateBuffer(template);
    const dir      = this.ensureUploadsDir();
    const filename = `${type}-${id}.pdf`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);
    return `/uploads/${filename}`;
  }
}
