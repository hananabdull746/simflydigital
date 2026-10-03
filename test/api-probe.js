// Offline probe: verifies how @itsliaaa/baileys renders the modern
// interactive button structure ({ name, buttonParamsJson }) and
// whether an extra `interactiveButtons` key is safe.
import { generateWAMessageContent } from '@itsliaaa/baileys';

const btn = (display_text, id) => ({
  name: 'quick_reply',
  buttonParamsJson: JSON.stringify({ display_text, id }),
});
const urlBtn = (display_text, url) => ({
  name: 'cta_url',
  buttonParamsJson: JSON.stringify({ display_text, url }),
});

async function probe(label, content) {
  try {
    const out = await generateWAMessageContent(content, {});
    console.log(`OK   ${label} ->`, JSON.stringify(out).slice(0, 400));
  } catch (err) {
    console.log(`FAIL ${label} -> ${err.message}`);
  }
}

await probe('nativeFlow only', {
  text: 'hello',
  footer: 'Simfly Store ⚡ Aapki Digital Zaroorat, Ek Store Mein',
  title: 'Simfly Store',
  nativeFlow: [btn('✅ Order Now', 'order_now'), btn('⬅️ Back', 'back_plans')],
});

await probe('nativeFlow + interactiveButtons (spec literal)', {
  text: 'hello',
  footer: 'Simfly Store ⚡ Aapki Digital Zaroorat, Ek Store Mein',
  title: 'Simfly Store',
  interactiveButtons: [btn('✅ Order Now', 'order_now')],
  nativeFlow: [btn('✅ Order Now', 'order_now'), urlBtn('💬 Support', 'https://wa.me/923000000000')],
});

await probe('legacy buttons [{id,text}]', {
  text: 'hello',
  footer: 'f',
  buttons: [{ id: 'a', text: 'A' }],
});

await probe('buttons [{name,paramsJson}]', {
  text: 'hello',
  footer: 'f',
  buttons: [{ name: 'quick_reply', paramsJson: JSON.stringify({ display_text: 'A', id: 'a' }) }],
});

await probe('list sections', {
  text: 'pick',
  title: 't',
  buttonText: 'Select',
  footer: 'f',
  sections: [{ title: 's', rows: [{ rowId: 'x', title: 'X', description: 'D' }] }],
});

