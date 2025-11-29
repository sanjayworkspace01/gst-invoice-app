require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');

const SHOP = process.env.SHOP;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;
const INVOICE_DIR = process.env.INVOICE_DIR || './invoices';

if (!SHOP || !TOKEN) {
  console.error('Missing SHOP or SHOPIFY_ACCESS_TOKEN in .env');
  process.exit(1);
}

if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });

const app = express();
app.use(express.json());

// load template
const templateSource = fs.readFileSync(path.join(__dirname,'templates','invoice.hbs'),'utf8');
const template = Handlebars.compile(templateSource);

// helper for index + 1
Handlebars.registerHelper('inc', function(value) {
  return parseInt(value) + 1;
});

// fetch order by ID
async function fetchOrder(orderId) {
  const url = `https://${SHOP}/admin/api/2024-10/orders/${orderId}.json`;
  const res = await axios.get(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
  return res.data.order;
}

// optional: fetch product metafields (used for hsn/rate) - basic example
async function fetchProductMetafields(productId) {
  try {
    const url = `https://${SHOP}/admin/api/2024-10/products/${productId}/metafields.json`;
    const res = await axios.get(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    return res.data.metafields || [];
  } catch (err) {
    return [];
  }
}

app.get('/invoice/:orderId', async (req, res) => {
  const orderId = req.params.orderId;
  try {
    const order = await fetchOrder(orderId);

    // seller static info from env
    const seller = {
      name: process.env.SELLER_NAME || 'Your Business',
      address: process.env.SELLER_ADDRESS || '',
      gstin: process.env.SELLER_GSTIN || ''
    };

    const buyer = {
      name: order.billing_address ? order.billing_address.name : order.email,
      address: order.billing_address ? `${order.billing_address.address1 || ''} ${order.billing_address.city || ''} ${order.billing_address.province || ''}` : '',
      gstin: '' // collect from checkout if B2B
    };

    // map items and compute GST (fallback 18%)
    const items = [];
    for (const li of order.line_items) {
      let hsn = '';
      let gst_rate = 18;
      if (li.product_id) {
        const mfs = await fetchProductMetafields(li.product_id);
        const h = mfs.find(m=>m.namespace==='gst' && m.key==='hsn');
        const r = mfs.find(m=>m.namespace==='gst' && m.key==='rate');
        if (h) hsn = h.value;
        if (r && !isNaN(parseFloat(r.value))) gst_rate = parseFloat(r.value);
      }
      const qty = li.quantity;
      const rate = parseFloat(li.price);
      const taxable = +(qty * rate).toFixed(2);
      const tax_amount = +(taxable * (gst_rate/100)).toFixed(2);
      items.push({
        title: li.name,
        hsn,
        quantity: qty,
        rate: rate.toFixed(2),
        taxable: taxable.toFixed(2),
        gst_rate: gst_rate.toFixed(2),
        tax_amount: tax_amount.toFixed(2)
      });
    }

    const totals = {
      taxable: items.reduce((s,i)=>s+parseFloat(i.taxable),0).toFixed(2),
      tax: items.reduce((s,i)=>s+parseFloat(i.tax_amount),0).toFixed(2)
    };
    totals.total = (parseFloat(totals.taxable) + parseFloat(totals.tax)).toFixed(2);

    const invoice_number = `INV-${Date.now()}`; // temporary unique invoice number; replace with sequence DB in production

    const html = template({
      seller,
      buyer,
      items,
      totals,
      invoice_number,
      date: new Date(order.created_at).toLocaleDateString('en-GB'),
      order_name: order.name,
      place_of_supply: order.shipping_address ? order.shipping_address.province : ''
    });

    // render to PDF
    const browser = await puppeteer.launch({ args:['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format:'A4', margin:{ top:'15mm', bottom:'15mm' }});
    await browser.close();

    const filename = `${invoice_number}.pdf`;
    const outPath = path.join(INVOICE_DIR, filename);
    fs.writeFileSync(outPath, pdfBuffer);

    // send PDF to browser
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=${filename}`
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error('Error generating invoice', err.response ? err.response.data : err);
    res.status(500).send('Error generating invoice - check server logs');
  }
});

app.listen(PORT, ()=>console.log(`GST Invoice app listening on ${PORT}`));
