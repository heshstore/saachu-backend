import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as PdfPrinter from 'pdfmake';
import { appConfig } from '../config/config';

const fonts = {
  Roboto: {
    normal: path.join(__dirname, '../../node_modules/pdfmake/build/vfs_fonts.js'),
    bold: path.join(__dirname, '../../node_modules/pdfmake/build/vfs_fonts.js'),
    italics: path.join(__dirname, '../../node_modules/pdfmake/build/vfs_fonts.js'),
    bolditalics: path.join(__dirname, '../../node_modules/pdfmake/build/vfs_fonts.js'),
  },
};

@Injectable()
export class PdfService {
  private printer: any;

  constructor() {
    try {
      this.printer = new (PdfPrinter as any)(fonts);
    } catch {
      this.printer = null;
    }
  }

  private ensureUploadsDir() {
    const dir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  quotationTemplate(data: any) {
    const NAVY  = '#1e3a8a';
    const SLATE = '#64748b';
    const LIGHT = '#f1f5f9';
    const RULE  = '#94a3b8';
    const inr   = (n: any) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const date  = (d: any) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

    const rows       = (data.items || []) as any[];
    const gstMap: Record<string, { pct: number; taxable: number; gst: number }> = {};
    for (const it of rows) {
      const taxable = Number(it.amount || 0);
      const pct     = Number(it.gst_percent || 0);
      if (pct <= 0) continue;
      const key     = String(pct);
      if (!gstMap[key]) gstMap[key] = { pct, taxable: 0, gst: 0 };
      gstMap[key].taxable += taxable;
      gstMap[key].gst     += taxable * pct / 100;
    }
    const gstSlabs      = Object.values(gstMap).sort((a, b) => a.pct - b.pct);
    const subTotal      = Number(data.sub_total || 0);
    const discType      = data.discount_type || 'PERCENT';
    const discValue     = Number(data.discount_value || 0);
    const headerDisc    = discType === 'FLAT' ? discValue : (subTotal * discValue) / 100;
    const totalCharges  =
      Number(data.charges_packing      || 0) +
      Number(data.charges_cartage      || 0) +
      Number(data.charges_forwarding   || 0) +
      Number(data.charges_installation || 0) +
      Number(data.charges_loading      || 0);
    const totalGst      = gstSlabs.reduce((s, r) => s + r.gst, 0);
    const grandTotal    = Number(data.total_amount || 0);

    // Items rows
    const itemRows = rows.map((it: any, i: number) => {
      const taxable = Number(it.amount || 0);
      const gstAmt  = taxable * Number(it.gst_percent || 0) / 100;
      return [
        { text: String(i + 1),                           alignment: 'center', fontSize: 8 },
        {
          stack: [
            { text: it.item_name || '-',                 bold: true, fontSize: 8.5 },
            ...(it.sku ? [{ text: `SKU: ${it.sku}`,     color: SLATE, fontSize: 7 }] : []),
          ],
        },
        { text: it.hsn_code || '—',                      alignment: 'center', fontSize: 8 },
        { text: String(Number(it.qty || 0)),              alignment: 'center', fontSize: 8 },
        { text: inr(it.rate),                             alignment: 'right',  fontSize: 8 },
        { text: `${Number(it.gst_percent || 0)}%`,        alignment: 'center', fontSize: 8 },
        { text: inr(gstAmt),                              alignment: 'right',  fontSize: 8 },
        { text: inr(taxable + gstAmt),                    alignment: 'right',  fontSize: 8, bold: true },
      ];
    });

    // Totals rows
    const totalRows: any[] = [
      [{ text: 'Sub Total', fontSize: 8 }, { text: inr(subTotal), alignment: 'right', fontSize: 8 }],
      ...(totalGst > 0 ? [[{ text: 'Total GST', fontSize: 8 }, { text: inr(totalGst), alignment: 'right', fontSize: 8 }]] : []),
      ...(headerDisc > 0 ? [[{ text: 'Discount', fontSize: 8, color: '#dc2626' }, { text: `−${inr(headerDisc)}`, alignment: 'right', fontSize: 8, color: '#dc2626' }]] : []),
      ...(totalCharges > 0 ? [[{ text: 'Extra Charges', fontSize: 8 }, { text: inr(totalCharges), alignment: 'right', fontSize: 8 }]] : []),
      [{ text: 'Grand Total', bold: true, fontSize: 10, color: '#fff', fillColor: NAVY }, { text: inr(grandTotal), alignment: 'right', bold: true, fontSize: 10, color: '#fff', fillColor: NAVY }],
    ];

    // GST summary rows
    const gstSummaryRows = gstSlabs.map((r) => [
      { text: `${r.pct}%`,    fontSize: 8 },
      { text: inr(r.taxable), alignment: 'right', fontSize: 8 },
      { text: inr(r.gst / 2), alignment: 'right', fontSize: 8 },
      { text: inr(r.gst / 2), alignment: 'right', fontSize: 8 },
      { text: inr(r.gst),     alignment: 'right', fontSize: 8, bold: true },
    ]);

    const billingCell = (label: string, name: string, addr: string, extra?: string) => ({
      stack: [
        { text: label,    fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 2] },
        { text: name,     fontSize: 9, bold: true },
        ...(addr  ? [{ text: addr,  fontSize: 7.5, color: SLATE, margin: [0, 1, 0, 0] }] : []),
        ...(extra ? [{ text: extra, fontSize: 7.5,               margin: [0, 1, 0, 0] }] : []),
      ],
      margin: [0, 0, 0, 0],
    });

    return {
      pageSize: 'A4',
      pageMargins: [34, 34, 34, 34],
      content: [
        // ── Header: company left | title centre | (no logo in pdfmake) ─
        {
          columns: [
            {
              stack: [
                { text: appConfig.companyName,       style: 'coName' },
                { text: `State: ${appConfig.companyState}`, style: 'coMeta' },
              ],
              width: '*',
            },
            {
              stack: [
                { text: 'PROFORMA INVOICE', style: 'docTitle', alignment: 'center' },
              ],
              width: 'auto',
              alignment: 'center',
            },
            { text: '', width: '*' },
          ],
          margin: [0, 0, 0, 6],
        },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 1.5, lineColor: NAVY }], margin: [0, 0, 0, 6] },

        // ── 3-column billing block ────────────────────────────────────
        {
          table: {
            widths: ['*', '*', 110],
            body: [[
              billingCell(
                'BILL TO',
                data.customer_name || '—',
                [data.billing_address, data.gst_number ? `GSTIN: ${data.gst_number}` : '', data.customer_phone ? `Ph: ${data.customer_phone}` : ''].filter(Boolean).join('\n'),
              ),
              billingCell(
                'DELIVERY TO',
                data.customer_name || '—',
                data.shipping_address || data.billing_address || '',
              ),
              {
                stack: [
                  { text: 'DOCUMENT DETAILS', fontSize: 7, bold: true, color: SLATE, margin: [0, 0, 0, 2] },
                  { text: [{ text: 'PI No: ', bold: true }, data.quotation_no || '—'], fontSize: 8 },
                  { text: [{ text: 'Date: ', bold: true }, date(data.created_at)],     fontSize: 8, margin: [0, 1, 0, 0] },
                  ...(data.valid_till ? [{ text: [{ text: 'Valid Till: ', bold: true }, date(data.valid_till)], fontSize: 8, margin: [0, 1, 0, 0] }] : []),
                  ...(data.payment_type ? [{ text: [{ text: 'Payment: ', bold: true }, data.payment_type],   fontSize: 8, margin: [0, 1, 0, 0] }] : []),
                  { text: [{ text: 'Customer: ', bold: true }, data.is_wholesaler ? 'Wholesale' : 'Retail'], fontSize: 8, margin: [0, 1, 0, 0] },
                ],
              },
            ]],
          },
          layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => RULE,
            vLineColor: () => RULE,
            paddingLeft:   () => 6,
            paddingRight:  () => 6,
            paddingTop:    () => 5,
            paddingBottom: () => 5,
          },
          margin: [0, 0, 0, 6],
        },

        // ── Items table ───────────────────────────────────────────────
        {
          table: {
            headerRows: 1,
            widths: [16, '*', 40, 28, 55, 28, 45, 50],
            body: [
              [
                { text: '#',          style: 'th', alignment: 'center' },
                { text: 'Description',style: 'th' },
                { text: 'HSN',        style: 'th', alignment: 'center' },
                { text: 'Qty',        style: 'th', alignment: 'center' },
                { text: 'Rate (₹)',   style: 'th', alignment: 'right' },
                { text: 'GST%',       style: 'th', alignment: 'center' },
                { text: 'GST Amt',    style: 'th', alignment: 'right' },
                { text: 'Amount (₹)', style: 'th', alignment: 'right' },
              ],
              ...itemRows,
            ],
          },
          layout: {
            hLineWidth: (i: number, node: any) => (i === 0 || i === node.table.headerRows || i === node.table.body.length) ? 0.75 : 0.35,
            vLineWidth: () => 0,
            hLineColor: (i: number) => i === 0 ? NAVY : RULE,
            fillColor:  (row: number) => row === 0 ? NAVY : (row % 2 === 0 ? LIGHT : null),
            paddingLeft:   () => 4,
            paddingRight:  () => 4,
            paddingTop:    () => 3,
            paddingBottom: () => 3,
          },
          margin: [0, 0, 0, 6],
        },

        // ── GST summary (left) + Totals (right) ───────────────────────
        {
          columns: [
            gstSlabs.length > 0 ? {
              width: '*',
              table: {
                headerRows: 1,
                widths: [28, '*', '*', '*', '*'],
                body: [
                  [
                    { text: 'Rate',     style: 'gstTh' },
                    { text: 'Taxable',  style: 'gstTh', alignment: 'right' },
                    { text: 'CGST',     style: 'gstTh', alignment: 'right' },
                    { text: 'SGST',     style: 'gstTh', alignment: 'right' },
                    { text: 'GST Tot.', style: 'gstTh', alignment: 'right' },
                  ],
                  ...gstSummaryRows,
                ],
              },
              layout: {
                hLineWidth: (i: number, node: any) => (i === 0 || i === node.table.headerRows || i === node.table.body.length) ? 0.5 : 0.25,
                vLineWidth: () => 0,
                hLineColor: () => RULE,
                fillColor:  (row: number) => row === 0 ? LIGHT : null,
                paddingLeft:   () => 3,
                paddingRight:  () => 3,
                paddingTop:    () => 2,
                paddingBottom: () => 2,
              },
            } : { text: '', width: '*' },
            {
              width: 170,
              table: {
                widths: ['*', 'auto'],
                body: totalRows,
              },
              layout: {
                hLineWidth: (i: number, node: any) => (i === node.table.body.length - 1 || i === node.table.body.length) ? 0 : 0.35,
                vLineWidth: () => 0,
                hLineColor: () => RULE,
                fillColor:  (_row: number, node: any, col: number) => (col === 0 ? null : null),
                paddingLeft:   () => 4,
                paddingRight:  () => 4,
                paddingTop:    () => 3,
                paddingBottom: () => 3,
              },
            },
          ],
          margin: [0, 0, 0, 10],
        },

        // ── Delivery / payment terms ──────────────────────────────────
        ...(data.payment_type || data.delivery_type || data.delivery_by ? [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 2, 0, 4] },
          {
            columns: [
              ...(data.delivery_type ? [{ text: [`Delivery Mode: `, { text: data.delivery_type, bold: true }], fontSize: 8, width: '*' }] : []),
              ...(data.delivery_by   ? [{ text: [`Deliver By: `,    { text: data.delivery_by,   bold: true }], fontSize: 8, width: '*' }] : []),
              ...(data.payment_type  ? [{ text: [`Payment Terms: `, { text: data.payment_type,  bold: true }], fontSize: 8, width: '*' }] : []),
            ],
            margin: [0, 0, 0, 4],
          },
        ] : []),

        // ── Terms & Conditions ────────────────────────────────────────
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 2, 0, 4] },
        { text: 'TERMS & CONDITIONS', fontSize: 7.5, bold: true, color: NAVY, margin: [0, 0, 0, 2] },
        {
          ol: [
            `Prices valid for the period stated. Subject to revision if validity lapses. GST applicable as per ${appConfig.companyState} norms.`,
            'Payment as per agreed terms. Goods remain property of seller until full payment received.',
            'All disputes subject to local jurisdiction only. E & O.E.',
          ],
          fontSize: 7.5,
          color: SLATE,
          margin: [0, 0, 0, 10],
        },

        // ── Footer ────────────────────────────────────────────────────
        {
          text: 'This is a computer-generated document. No signature required.',
          fontSize: 7, color: '#94a3b8', alignment: 'center',
        },
      ],
      styles: {
        coName:   { fontSize: 14, bold: true, color: NAVY },
        coMeta:   { fontSize: 8,  color: SLATE, margin: [0, 2, 0, 0] },
        docTitle: { fontSize: 13, bold: true,  color: NAVY, letterSpacing: 1 },
        th:       { bold: true, fontSize: 8,  color: '#fff', fillColor: NAVY },
        gstTh:    { bold: true, fontSize: 7.5, color: SLATE, fillColor: LIGHT },
      },
      defaultStyle: { fontSize: 8.5, font: 'Roboto' },
    };
  }

  orderTemplate(data: any) {
    const items = (data.items || []).map((item: any, i: number) => [
      String(i + 1),
      item.itemName || '-',
      String(item.quantity || item.qty || 0),
      `₹${Number(item.rate || 0).toFixed(2)}`,
      `₹${Number(item.amount || 0).toFixed(2)}`,
    ]);

    return {
      content: [
        { text: appConfig.companyName, style: 'header' },
        { text: `ORDER: ${data.order_number || ''}`, style: 'subheader' },
        { text: `Customer: ${data.customer_name || ''}`, margin: [0, 4, 0, 8] },
        {
          table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto', 'auto', 'auto'],
            body: [['#', 'Item', 'Qty', 'Rate', 'Amount'], ...items],
          },
        },
        { text: `Total: ₹${Number(data.total_amount || 0).toFixed(2)}`, style: 'total', margin: [0, 12, 0, 0] },
      ],
      styles: {
        header: { fontSize: 18, bold: true },
        subheader: { fontSize: 14, bold: true, margin: [0, 4, 0, 4] },
        total: { fontSize: 14, bold: true, alignment: 'right' },
      },
    };
  }

  invoiceTemplate(data: any) {
    const items = (data.items || []).map((item: any, i: number) => [
      String(i + 1),
      item.itemName || '-',
      String(item.quantity || 0),
      `₹${Number(item.rate || 0).toFixed(2)}`,
      `₹${Number(item.amount || 0).toFixed(2)}`,
    ]);

    return {
      content: [
        { text: appConfig.companyName, style: 'header' },
        { text: `INVOICE: ${data.invoice_no || data.id || ''}`, style: 'subheader' },
        { text: `Customer: ${data.customer_name || ''}`, margin: [0, 4, 0, 8] },
        {
          table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto', 'auto', 'auto'],
            body: [['#', 'Item', 'Qty', 'Rate', 'Amount'], ...items],
          },
        },
        { text: `Sub Total: ₹${Number(data.sub_total || 0).toFixed(2)}`, margin: [0, 8, 0, 2], alignment: 'right' },
        { text: `GST: ₹${Number((data.cgst || 0) + (data.sgst || 0) + (data.igst || 0)).toFixed(2)}`, margin: [0, 0, 0, 2], alignment: 'right' },
        { text: `Total: ₹${Number(data.total_amount || 0).toFixed(2)}`, style: 'total', margin: [0, 4, 0, 0] },
      ],
      styles: {
        header: { fontSize: 18, bold: true },
        subheader: { fontSize: 14, bold: true, margin: [0, 4, 0, 4] },
        total: { fontSize: 14, bold: true, alignment: 'right' },
      },
    };
  }

  async generateBuffer(docDefinition: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.printer) {
        reject(new Error('PDF printer not available'));
        return;
      }
      const doc = this.printer.createPdfKitDocument(docDefinition);
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }

  async generateAndSave(type: 'quotation' | 'order' | 'invoice', id: number, data: any): Promise<string> {
    let template: any;
    if (type === 'quotation') template = this.quotationTemplate(data);
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
