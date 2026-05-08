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
    const fmt = (n: any) => `₹${Number(n || 0).toFixed(2)}`;
    const date = (d: any) => d ? new Date(d).toLocaleDateString('en-IN') : '-';

    const rows = (data.items || []);

    // GST summary — group by rate
    const gstMap: Record<string, { taxable: number; gst: number }> = {};
    for (const item of rows) {
      const taxable   = Number(item.amount || 0);
      const pct       = Number(item.gst_percent || 0);
      const gstAmt    = taxable * pct / 100;
      const key       = `${pct}`;
      if (!gstMap[key]) gstMap[key] = { taxable: 0, gst: 0 };
      gstMap[key].taxable += taxable;
      gstMap[key].gst     += gstAmt;
    }

    const subTotal       = Number(data.sub_total || 0);
    const discountType   = data.discount_type  || 'PERCENT';
    const discountValue  = Number(data.discount_value || 0);
    const headerDiscount = discountType === 'FLAT'
      ? discountValue
      : (subTotal * discountValue) / 100;
    const charges =
      Number(data.charges_packing || 0) +
      Number(data.charges_cartage || 0) +
      Number(data.charges_forwarding || 0) +
      Number(data.charges_installation || 0) +
      Number(data.charges_loading || 0);
    const totalGst = Object.values(gstMap).reduce((s, g) => s + g.gst, 0);
    const grandTotal = Number(data.total_amount || 0);

    const itemRows = rows.map((item: any, i: number) => {
      const taxable = Number(item.amount || 0);
      const gstAmt  = taxable * Number(item.gst_percent || 0) / 100;
      return [
        { text: String(i + 1),                        alignment: 'center' },
        { text: item.item_name || item.itemName || '-' },
        { text: item.hsn_code || '-',                  alignment: 'center' },
        { text: String(Number(item.qty || 0)),          alignment: 'center' },
        { text: fmt(item.rate),                         alignment: 'right' },
        { text: `${Number(item.gst_percent || 0)}%`,    alignment: 'center' },
        { text: fmt(gstAmt),                            alignment: 'right' },
        { text: fmt(taxable + gstAmt),                  alignment: 'right', bold: true },
      ];
    });

    const gstRows = Object.entries(gstMap).map(([pct, val]) => [
      { text: `GST @ ${pct}%`, colSpan: 3, alignment: 'right' }, {}, {},
      { text: fmt(val.taxable), alignment: 'right' },
      { text: fmt(val.gst / 2), alignment: 'right' },
      { text: fmt(val.gst / 2), alignment: 'right' },
      { text: fmt(val.gst), alignment: 'right', colSpan: 2 }, {},
    ]);

    return {
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 40],
      content: [
        // ── Company header ──────────────────────────────────────────
        {
          columns: [
            {
              stack: [
                { text: appConfig.companyName, style: 'companyName' },
                { text: `State: ${appConfig.companyState}`, style: 'companyMeta' },
              ],
            },
            {
              stack: [
                { text: 'QUOTATION', style: 'docTitle' },
                { text: `No: ${data.quotation_no || '-'}`, style: 'docMeta' },
                { text: `Date: ${date(data.created_at)}`,  style: 'docMeta' },
                { text: `Valid Till: ${date(data.valid_till)}`, style: 'docMeta' },
              ],
              alignment: 'right',
            },
          ],
          margin: [0, 0, 0, 12],
        },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1 }], margin: [0, 0, 0, 10] },

        // ── Billing block ───────────────────────────────────────────
        {
          columns: [
            {
              stack: [
                { text: 'BILL TO', style: 'blockLabel' },
                { text: data.customer_name || '-', bold: true, fontSize: 10 },
                { text: data.billing_address || '', fontSize: 9, color: '#555' },
                data.gst_number ? { text: `GSTIN: ${data.gst_number}`, fontSize: 9 } : {},
              ],
              width: '*',
            },
            {
              stack: [
                { text: 'SHIP TO', style: 'blockLabel' },
                { text: data.customer_name || '-', bold: true, fontSize: 10 },
                { text: data.shipping_address || data.billing_address || '', fontSize: 9, color: '#555' },
              ],
              width: '*',
            },
          ],
          margin: [0, 0, 0, 12],
        },

        // ── Items table ─────────────────────────────────────────────
        {
          table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
            body: [
              [
                { text: '#',        style: 'th', alignment: 'center' },
                { text: 'Item',     style: 'th' },
                { text: 'HSN',      style: 'th', alignment: 'center' },
                { text: 'Qty',      style: 'th', alignment: 'center' },
                { text: 'Rate',     style: 'th', alignment: 'right' },
                { text: 'GST%',     style: 'th', alignment: 'center' },
                { text: 'GST Amt',  style: 'th', alignment: 'right' },
                { text: 'Total',    style: 'th', alignment: 'right' },
              ],
              ...itemRows,
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 0, 0, 8],
        },

        // ── GST summary ─────────────────────────────────────────────
        ...(Object.keys(gstMap).length > 0 ? [
          {
            table: {
              widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
              body: [
                [
                  { text: 'GST Rate', style: 'th', colSpan: 3 }, {}, {},
                  { text: 'Taxable', style: 'th', alignment: 'right' },
                  { text: 'CGST', style: 'th', alignment: 'right' },
                  { text: 'SGST', style: 'th', alignment: 'right' },
                  { text: 'Total GST', style: 'th', alignment: 'right', colSpan: 2 }, {},
                ],
                ...gstRows,
              ],
            },
            layout: 'lightHorizontalLines',
            margin: [0, 0, 0, 8],
          },
        ] : []),

        // ── Totals ──────────────────────────────────────────────────
        {
          columns: [
            { text: '', width: '*' },
            {
              width: 220,
              table: {
                widths: ['*', 'auto'],
                body: [
                  [{ text: 'Sub Total', alignment: 'left' }, { text: fmt(subTotal), alignment: 'right' }],
                  ...(totalGst > 0 ? [[{ text: 'Total GST', alignment: 'left' }, { text: fmt(totalGst), alignment: 'right' }]] : []),
                  ...(headerDiscount > 0 ? [[{ text: 'Discount', alignment: 'left', color: '#dc2626' }, { text: `-${fmt(headerDiscount)}`, alignment: 'right', color: '#dc2626' }]] : []),
                  ...(charges > 0 ? [[{ text: 'Extra Charges', alignment: 'left' }, { text: fmt(charges), alignment: 'right' }]] : []),
                  [{ text: 'Grand Total', bold: true, fontSize: 11 }, { text: fmt(grandTotal), bold: true, fontSize: 11, alignment: 'right' }],
                ],
              },
              layout: 'lightHorizontalLines',
            },
          ],
          margin: [0, 0, 0, 16],
        },

        // ── Delivery / payment ──────────────────────────────────────
        ...(data.payment_type || data.delivery_type || data.delivery_by ? [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5 }], margin: [0, 4, 0, 6] },
          {
            columns: [
              data.payment_type  ? { text: `Payment: ${data.payment_type}`,  fontSize: 9, color: '#444' } : {},
              data.delivery_type ? { text: `Delivery: ${data.delivery_type}`, fontSize: 9, color: '#444' } : {},
              data.delivery_by   ? { text: `Deliver By: ${data.delivery_by}`, fontSize: 9, color: '#444' } : {},
            ],
          },
        ] : []),

        // ── Footer note ─────────────────────────────────────────────
        {
          text: 'This is a computer-generated quotation and does not require a signature.',
          fontSize: 8, color: '#888', margin: [0, 16, 0, 0], alignment: 'center',
        },
      ],
      styles: {
        companyName: { fontSize: 16, bold: true },
        companyMeta: { fontSize: 9, color: '#555', margin: [0, 2, 0, 0] },
        docTitle:    { fontSize: 18, bold: true, color: '#1e3a8a' },
        docMeta:     { fontSize: 9, color: '#444', margin: [0, 1, 0, 0] },
        blockLabel:  { fontSize: 8, bold: true, color: '#888', margin: [0, 0, 0, 3], letterSpacing: 1 },
        th:          { bold: true, fontSize: 9, fillColor: '#f1f5f9' },
        total:       { fontSize: 14, bold: true, alignment: 'right' },
      },
      defaultStyle: { fontSize: 9 },
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
