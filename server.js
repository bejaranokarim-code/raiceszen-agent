/**
 * RaícesZen AI Sales Agent — Backend
 * Node.js + Express + Anthropic Claude
 * 
 * Required env vars:
 *   ANTHROPIC_API_KEY
 *   SHOPIFY_STORE_DOMAIN       (raiceszen.myshopify.com)
 *   SHOPIFY_STOREFRONT_TOKEN   (public Storefront API token)
 *   SHOPIFY_ADMIN_TOKEN        (Admin API token — for orders)
 *   PORT                       (default 3000)
 *   WHATSAPP_NUMBER            (for escalation, e.g. 5215512345678)
 */

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CACHE (catalog, discounts, faqs) ─────────────────────────────────────────
const cache = new NodeCache({ stdTTL: 600 });
const sessionCache = new NodeCache({ stdTTL: 3600 });

app.use(cors({ origin: ['https://raiceszen.mx', 'https://raiceszen.myshopify.com', 'http://localhost:*'] }));
app.use(express.json({ limit: '50kb' }));
app.use(rateLimit({ windowMs: 60_000, max: 30, message: { error: 'Too many requests' } }));

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function storefrontQuery(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function adminQuery(path) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-01/${path}`, {
    headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN }
  });
  return res.json();
}

async function loadKnowledgeBase() {
  const cached = cache.get('knowledge_base');
  if (cached) return cached;
  const [productsData, collectionsData, policiesData, discountsData] = await Promise.allSettled([fetchAllProducts(), fetchCollections(), fetchPolicies(), fetchDiscounts()]);
  const kb = { products: productsData.status === 'fulfilled' ? productsData.value : [], collections: collectionsData.status === 'fulfilled' ? collectionsData.value : [], policies: policiesData.status === 'fulfilled' ? policiesData.value : {}, discounts: discountsData.status === 'fulfilled' ? discountsData.value : [], loadedAt: new Date().toISOString() };
  cache.set('knowledge_base', kb, 600);
  return kb;
}

async function fetchAllProducts() {
  const query = `{products(first: 100) { edges { node { id handle title descriptionHtml productType tags vendor priceRange { minVariantPrice { amount currencyCode } } compareAtPriceRange { minVariantPrice { amount } } featuredImage { url altText } variants(first: 5) { edges { node { id title price { amount } availableForSale } } } collections(first: 3) { edges { node { handle title } } } metafields(identifiers: [{namespace: "custom", key: "beneficios"},{namespace: "custom", key: "modo_de_uso"},{namespace: "custom", key: "ingredientes"}]) { key value } } } }}`;
  const data = await storefrontQuery(query);
  return data?.data?.products?.edges?.map(e => ({ id: e.node.id, handle: e.node.handle, title: e.node.title, description: e.node.descriptionHtml?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 800), productType: e.node.productType, tags: e.node.tags, price: parseFloat(e.node.priceRange?.minVariantPrice?.amount || 0), comparePrice: parseFloat(e.node.compareAtPriceRange?.minVariantPrice?.amount || 0) || null, currency: e.node.priceRange?.minVariantPrice?.currencyCode, image: e.node.featuredImage?.url, url: `https://raiceszen.mx/products/${e.node.handle}`, variants: e.node.variants?.edges?.map(v => ({ id: v.node.id.replace('gid://shopify/ProductVariant/', ''), title: v.node.title, price: parseFloat(v.node.price?.amount), available: v.node.availableForSale })), collections: e.node.collections?.edges?.map(c => c.node.handle), beneficios: e.node.metafields?.find(m => m?.key === 'beneficios')?.value, modoDeUso: e.node.metafields?.find(m => m?.key === 'modo_de_uso')?.value, ingredientes: e.node.metafields?.find(m => m?.key === 'ingredientes')?.value })) || [];
}

async function fetchCollections() {
  const query = `{collections(first: 30) { edges { node { id handle title descriptionHtml image { url } } } }}`;
  const data = await storefrontQuery(query);
  return data?.data?.collections?.edges?.map(e => ({ handle: e.node.handle, title: e.node.title, description: e.node.descriptionHtml?.replace(/<[^>]+>/g, '').trim().substring(0, 300), url: `https://raiceszen.mx/collections/${e.node.handle}` })) || [];
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId: reqSessionId, context = {} } = req.body;
    if (!message || typeof message !== 'string' || message.length > 500) return res.status(400).json({ error: 'Invalid message' });
    const sessionId = reqSessionId || randomUUID();
    const session = sessionCache.get(sessionId) || { messages: [] };
    const kb = await loadKnowledgeBase();
    const intent = message.toLowerCase();
    let orderData = null;
    const systemPrompt = `Eres Zen, asistente de RaícesZen. Catálogo: ${JSON.stringify(kb.products.slice(0,20))}. Responde siempre en JSON: {"text":"","products":null,"quickReplies":null,"escalate":null}`;
    const claudeRes = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages: [...session.messages.slice(-10), { role: 'user', content: message }] });
    const rawText = claudeRes.content[0]?.text || '{}';
    let parsed; try { parsed = JSON.parse(rawText.match(/\[\s\S]*\}/)[0]); } catch { parsed = { text: rawText }; }
    session.messages.push({ role: 'user', content: message }, { role: 'assistant', content: parsed.text || '' });
    sessionCache.set(sessionId, session);
    res.json({ ...parsed, sessionId });
  } catch (err) { console.error(err); res.status(500).json({ text: 'Error', error: true }); }
});

async function fetchDiscounts() { try { return []; } catch { return []; } }
async function fetchPolicies() { try { return {}; } catch { return {}; } }

app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.post('/api/admin/settings', (req, res) => res.json({ ok: true }));
app.get('/api/admin/settings', (req, res) => res.json({}));
app.post('/api/webhooks/products-update', (req, res) => { cache.del('knowledge_base'); res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RaícesZen Agent running on :${PORT}`));
