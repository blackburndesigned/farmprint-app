//! Smaller IPC replies: the UI sends the `order_hash` of every order it already holds,
//! and a snapshot reply then carries only the orders that changed (plus the full order
//! id list so removals and order are kept). Stateless: nothing is cached in the ledger.

use crate::models::Order;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Hash of everything the UI shows for an order (its JSON, `order_hash` left empty).
pub fn order_content_hash(order: &Order) -> String {
    let bytes = if order.order_hash.is_empty() {
        serde_json::to_vec(order)
    } else {
        let mut o = order.clone();
        o.order_hash.clear();
        serde_json::to_vec(&o)
    }
    .unwrap_or_default();
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// If `reply` is a snapshot (an object with an `orders` array) and `known` maps order id to
/// hash, drops every order whose hash matches and adds `order_ids` (all ids, in order) and
/// `delta: true`. Returns true when the reply was turned into a delta.
pub fn strip_known_orders(reply: &mut Value, known: &Value) -> bool {
    let Some(known) = known.as_object() else {
        return false;
    };
    let Some(obj) = reply.as_object_mut() else {
        return false;
    };
    let Some(Value::Array(orders)) = obj.get_mut("orders") else {
        return false;
    };
    let mut ids = Vec::with_capacity(orders.len());
    let mut kept = Vec::new();
    for o in orders.drain(..) {
        let id = o
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let hash = o
            .get("order_hash")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let same = !hash.is_empty() && known.get(&id).and_then(Value::as_str) == Some(hash);
        ids.push(Value::String(id));
        if !same {
            kept.push(o);
        }
    }
    *orders = kept;
    obj.insert("order_ids".to_string(), Value::Array(ids));
    obj.insert("delta".to_string(), Value::Bool(true));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ShopLedger, TransitionRequest};
    use serde_json::json;

    #[test]
    fn delta_keeps_only_changed_orders_and_all_ids() {
        let mut ledger = ShopLedger::open_in_memory().unwrap();
        let before = ledger.snapshot().unwrap();
        let known: serde_json::Map<String, Value> = before
            .orders
            .iter()
            .map(|o| (o.id.clone(), json!(o.order_hash)))
            .collect();
        let after = ledger
            .transition_units(TransitionRequest {
                unit_ids: vec!["unit-demo-4-base".into()],
                to_state: "Ready".into(),
                printer_id: None,
                actor_device: "t".into(),
                source_surface: "t".into(),
                action_label: "t".into(),
                failure_reason: None,
                failure_note: None,
                filament_id: None,
            })
            .unwrap();
        let mut reply = serde_json::to_value(&after).unwrap();
        assert!(strip_known_orders(&mut reply, &Value::Object(known)));
        let ids: Vec<&str> = reply["order_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), before.orders.len());
        let sent: Vec<&str> = reply["orders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["id"].as_str().unwrap())
            .collect();
        assert!(sent.contains(&"ord-demo-4"));
        assert!(!sent.contains(&"ord-demo-1"), "unchanged order not resent");
        assert_eq!(reply["delta"], json!(true));
    }

    #[test]
    fn non_snapshot_replies_are_untouched() {
        let mut v = json!({"ok": true});
        assert!(!strip_known_orders(&mut v, &json!({})));
        assert_eq!(v, json!({"ok": true}));
        let mut s = json!({"orders": []});
        assert!(!strip_known_orders(&mut s, &json!(null)));
    }
}
