# assets/ — manual eSIM uploads

Drop any QR / activation image here, then point `data/deliveries.json` at it.

## Example

1. Save your QR as `assets/esim-plan-1gb-7d.png`
2. Edit `data/deliveries.json`:

```json
{
  "default": { "text": "...", "image": null },
  "plans": {
    "plan_1gb": {
      "text": "Plan: Telenor/Zong 1GB (1GB / No Expiry)\n\nScan the attached QR to install.",
      "image": "assets/esim-plan-1gb.png"
    }
  },
  "orders": {
    "SMF-0001": { "text": "One-off payload for this order", "image": "assets/order-SMF-0001.png" }
  }
}
```

## Lookup order

`orders[ORDER_ID]` → `plans[PLAN_ID]` → `default`

Edit the file any time — the bot re-reads it on every delivery, no restart needed.
