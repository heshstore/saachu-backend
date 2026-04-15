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
    const items = (data.items || []).map((item: any, i: number) => [
      String(i + 1),
      item.item_name || item.itemName || '-',
      item.sku || '-',
      String(item.qty || 0),
      `₹${Number(item.rate || 0).toFixed(2)}`,
      `₹${Number(item.amount || 0).toFixed(2)}`,
    ]);

    return {
      content: [
        { text: appConfig.companyName, style: 'header' },
        { text: `QUOTATION: ${data.quotation_no || ''}`, style: 'subheader' },
        { text: `Customer: ${data.customer_name || ''}`, margin: [0, 4, 0, 0] },
        { text: `Date: ${new Date(data.created_at || Date.now()).toLocaleDateString('en-IN')}`, margin: [0, 2, 0, 8] },
        {
          table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto'],
            body: [
              ['#', 'Item', 'SKU', 'Qty', 'Rate', 'Amount'],
              ...items,
            ],
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
