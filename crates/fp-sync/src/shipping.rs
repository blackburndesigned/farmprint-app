use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Standard shipping box classes used across FarmPrint and the store snapshot.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum ShippingBoxClass {
    #[default]
    NotSet,
    Ignore,
    Small,
    Medium,
    Large,
}

/// Box rates in cents (defaulting to FarmPrint's standard USPS rates: Small 1089, Medium 2028, Large 2806).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShippingRatesCents {
    pub small: i64,
    pub medium: i64,
    pub large: i64,
}

impl Default for ShippingRatesCents {
    fn default() -> Self {
        Self {
            small: 1089,
            medium: 2028,
            large: 2806,
        }
    }
}

impl ShippingRatesCents {
    pub fn rate_for(&self, class: ShippingBoxClass) -> i64 {
        match class {
            ShippingBoxClass::Small => self.small,
            ShippingBoxClass::Medium => self.medium,
            ShippingBoxClass::Large => self.large,
            ShippingBoxClass::Ignore | ShippingBoxClass::NotSet => 0,
        }
    }
}

/// Per-product shipping configuration published in the store catalog snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductShippingSpec {
    pub product_id: String,
    pub box_class: ShippingBoxClass,
    /// Maximum units of this product that fit in a single box of `box_class` when shipped alone.
    pub per_box: u32,
}

/// A "Ships together" (`share`) rule that lets multiple products combine into one target box
/// up to a per-product cap per shared box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareBoxRule {
    pub id: String,
    pub box_class: ShippingBoxClass,
    /// Map of `product_id -> max_units_per_shared_box`.
    pub limits: BTreeMap<String, u32>,
}

/// Line item quantity for shipping calculation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShippingCartItem {
    pub product_id: String,
    pub quantity: u32,
}

/// Result of a shipping quote calculation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShippingQuote {
    pub total_cents: i64,
    pub total_boxes: u32,
    pub boxes: Vec<PackedBox>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackedBox {
    pub box_class: ShippingBoxClass,
    pub rate_cents: i64,
    pub shared_rule_id: Option<String>,
    pub items: BTreeMap<String, u32>,
}

/// Compute standalone boxes and cost for remaining item counts without any share rules.
fn quote_standalone(
    counts: &BTreeMap<String, u32>,
    specs: &BTreeMap<String, ProductShippingSpec>,
    rates: &ShippingRatesCents,
) -> (i64, u32, Vec<PackedBox>) {
    let mut total_cents = 0i64;
    let mut total_boxes = 0u32;
    let mut packed = Vec::new();

    for (product_id, &qty) in counts {
        if qty == 0 {
            continue;
        }
        let Some(spec) = specs.get(product_id) else {
            continue;
        };
        if matches!(
            spec.box_class,
            ShippingBoxClass::Ignore | ShippingBoxClass::NotSet
        ) {
            continue;
        }
        let per_box = spec.per_box.max(1);
        let rate = rates.rate_for(spec.box_class);
        let mut rem = qty;
        while rem > 0 {
            let take = rem.min(per_box);
            rem -= take;
            let mut items = BTreeMap::new();
            items.insert(product_id.clone(), take);
            packed.push(PackedBox {
                box_class: spec.box_class,
                rate_cents: rate,
                shared_rule_id: None,
                items,
            });
            total_cents += rate;
            total_boxes += 1;
        }
    }

    (total_cents, total_boxes, packed)
}

/// Quote shipping for a cart using FarmPrint's exact `ShippingPack` rules:
/// - Ignored / NotSet products are skipped.
/// - Each product ships in boxes of `box_class` holding up to `per_box` units.
/// - A `ShareBoxRule` ("Ships together") combines 2+ distinct products into one box only when
///   doing so is strictly cheaper than shipping them separately, or the same postage with fewer boxes.
/// - Rules can apply more than once.
pub fn quote_shipping(
    cart: &[ShippingCartItem],
    product_specs: &[ProductShippingSpec],
    share_rules: &[ShareBoxRule],
    rates: &ShippingRatesCents,
) -> ShippingQuote {
    let specs: BTreeMap<String, ProductShippingSpec> = product_specs
        .iter()
        .map(|s| (s.product_id.clone(), s.clone()))
        .collect();

    let mut remaining: BTreeMap<String, u32> = BTreeMap::new();
    for item in cart {
        if item.quantity == 0 {
            continue;
        }
        if let Some(spec) = specs.get(&item.product_id) {
            if !matches!(
                spec.box_class,
                ShippingBoxClass::Ignore | ShippingBoxClass::NotSet
            ) {
                *remaining.entry(item.product_id.clone()).or_insert(0) += item.quantity;
            }
        }
    }

    let mut shared_boxes: Vec<PackedBox> = Vec::new();

    // Repeatedly apply the best beneficial share rule while at least 2 participating products remain.
    loop {
        let (base_cents, base_boxes, _) = quote_standalone(&remaining, &specs, rates);
        let mut best_candidate: Option<(i64, u32, PackedBox, BTreeMap<String, u32>)> = None;

        for rule in share_rules {
            if matches!(
                rule.box_class,
                ShippingBoxClass::Ignore | ShippingBoxClass::NotSet
            ) {
                continue;
            }
            let mut taken: BTreeMap<String, u32> = BTreeMap::new();
            for (pid, &limit) in &rule.limits {
                if limit == 0 {
                    continue;
                }
                if let Some(&rem_qty) = remaining.get(pid) {
                    if rem_qty > 0 {
                        taken.insert(pid.clone(), rem_qty.min(limit));
                    }
                }
            }
            // Share rules combine multiple products together (at least 2 distinct products).
            if taken.len() < 2 {
                continue;
            }

            let mut next_remaining = remaining.clone();
            for (pid, &t) in &taken {
                if let Some(entry) = next_remaining.get_mut(pid) {
                    *entry = entry.saturating_sub(t);
                }
            }

            let rule_rate = rates.rate_for(rule.box_class);
            let (after_cents, after_boxes, _) = quote_standalone(&next_remaining, &specs, rates);
            let candidate_cents = rule_rate + after_cents;
            let candidate_boxes = 1 + after_boxes;

            let improves = candidate_cents < base_cents
                || (candidate_cents == base_cents && candidate_boxes < base_boxes);

            if improves {
                let packed_box = PackedBox {
                    box_class: rule.box_class,
                    rate_cents: rule_rate,
                    shared_rule_id: Some(rule.id.clone()),
                    items: taken,
                };
                match &best_candidate {
                    None => {
                        best_candidate =
                            Some((candidate_cents, candidate_boxes, packed_box, next_remaining));
                    }
                    Some((best_c, best_b, _, _)) => {
                        if candidate_cents < *best_c
                            || (candidate_cents == *best_c && candidate_boxes < *best_b)
                        {
                            best_candidate = Some((
                                candidate_cents,
                                candidate_boxes,
                                packed_box,
                                next_remaining,
                            ));
                        }
                    }
                }
            }
        }

        if let Some((_, _, packed_box, next_rem)) = best_candidate {
            shared_boxes.push(packed_box);
            remaining = next_rem;
        } else {
            break;
        }
    }

    let (_, _, mut standalone_boxes) = quote_standalone(&remaining, &specs, rates);
    let mut all_boxes = shared_boxes;
    all_boxes.append(&mut standalone_boxes);

    let total_cents = all_boxes.iter().map(|b| b.rate_cents).sum();
    let total_boxes = all_boxes.len() as u32;

    ShippingQuote {
        total_cents,
        total_boxes,
        boxes: all_boxes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard_specs_and_rules() -> (
        Vec<ProductShippingSpec>,
        Vec<ShareBoxRule>,
        ShippingRatesCents,
    ) {
        let specs = vec![
            ProductShippingSpec {
                product_id: "prod-test-gadget".to_string(), // Gadget
                box_class: ShippingBoxClass::Small,
                per_box: 8,
            },
            ProductShippingSpec {
                product_id: "prod-test-widget".to_string(), // Widget
                box_class: ShippingBoxClass::Small,
                per_box: 5,
            },
        ];
        let mut limits = BTreeMap::new();
        limits.insert("prod-test-gadget".to_string(), 4);
        limits.insert("prod-test-widget".to_string(), 4);
        let rules = vec![ShareBoxRule {
            id: "share-small-gadget-widget".to_string(),
            box_class: ShippingBoxClass::Small,
            limits,
        }];
        (specs, rules, ShippingRatesCents::default())
    }

    #[test]
    fn shipping_contract_check_cases() {
        let (specs, rules, rates) = standard_specs_and_rules();

        // 4 gadgets + 4 widgets = 1089 (1 shared Small box)
        let q1 = quote_shipping(
            &[
                ShippingCartItem {
                    product_id: "prod-test-gadget".to_string(),
                    quantity: 4,
                },
                ShippingCartItem {
                    product_id: "prod-test-widget".to_string(),
                    quantity: 4,
                },
            ],
            &specs,
            &rules,
            &rates,
        );
        assert_eq!(q1.total_cents, 1089);
        assert_eq!(q1.total_boxes, 1);

        // 8 gadgets = 1089 (1 Small box)
        let q2 = quote_shipping(
            &[ShippingCartItem {
                product_id: "prod-test-gadget".to_string(),
                quantity: 8,
            }],
            &specs,
            &rules,
            &rates,
        );
        assert_eq!(q2.total_cents, 1089);
        assert_eq!(q2.total_boxes, 1);

        // 9 gadgets = 2178 (2 Small boxes)
        let q3 = quote_shipping(
            &[ShippingCartItem {
                product_id: "prod-test-gadget".to_string(),
                quantity: 9,
            }],
            &specs,
            &rules,
            &rates,
        );
        assert_eq!(q3.total_cents, 2178);
        assert_eq!(q3.total_boxes, 2);

        // 5 widgets = 1089 (1 Small box)
        let q4 = quote_shipping(
            &[ShippingCartItem {
                product_id: "prod-test-widget".to_string(),
                quantity: 5,
            }],
            &specs,
            &rules,
            &rates,
        );
        assert_eq!(q4.total_cents, 1089);
        assert_eq!(q4.total_boxes, 1);

        // 6 widgets = 2178 (2 Small boxes)
        let q5 = quote_shipping(
            &[ShippingCartItem {
                product_id: "prod-test-widget".to_string(),
                quantity: 6,
            }],
            &specs,
            &rules,
            &rates,
        );
        assert_eq!(q5.total_cents, 2178);
        assert_eq!(q5.total_boxes, 2);
    }
}
