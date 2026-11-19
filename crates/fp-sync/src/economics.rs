use serde::{Deserialize, Serialize};

/// Inputs for calculating true unit manufacturing cost of a single printed part.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartCostInput {
    pub part_id: String,
    pub part_name: String,
    pub filament_grams: f64,
    pub spool_price_cents: i64,
    pub spool_weight_grams: f64,
    /// Historical or configured failure buffer (e.g. 0.05 for 5%).
    pub failure_buffer_pct: f64,
    pub print_hours: f64,
    pub machine_hourly_rate_cents: i64,
    /// Number of failed reprints recorded for this part unit in the event ledger.
    pub failed_reprint_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartCostBreakdown {
    pub part_id: String,
    pub part_name: String,
    pub base_filament_cost_cents: i64,
    pub failure_buffer_cost_cents: i64,
    pub machine_time_cost_cents: i64,
    pub reprint_drain_cents: i64,
    pub reprint_grams: f64,
    pub total_part_cost_cents: i64,
}

/// Compute true cost of a part including filament, failure buffer, machine amortization, and actual reprints.
pub fn compute_part_cost(input: &PartCostInput) -> PartCostBreakdown {
    let spool_weight = if input.spool_weight_grams > 0.0 {
        input.spool_weight_grams
    } else {
        1000.0
    };
    let cents_per_gram = (input.spool_price_cents as f64) / spool_weight;
    let base_filament = input.filament_grams * cents_per_gram;
    let buffer_cost = base_filament * input.failure_buffer_pct.max(0.0);
    let machine_cost = input.print_hours.max(0.0) * (input.machine_hourly_rate_cents as f64);

    let single_run_cost = base_filament + machine_cost;
    let reprint_grams = input.filament_grams * (input.failed_reprint_count as f64);
    let reprint_drain = single_run_cost * (input.failed_reprint_count as f64);

    let base_filament_cost_cents = base_filament.round() as i64;
    let failure_buffer_cost_cents = buffer_cost.round() as i64;
    let machine_time_cost_cents = machine_cost.round() as i64;
    let reprint_drain_cents = reprint_drain.round() as i64;

    let total_part_cost_cents = base_filament_cost_cents
        + failure_buffer_cost_cents
        + machine_time_cost_cents
        + reprint_drain_cents;

    PartCostBreakdown {
        part_id: input.part_id.clone(),
        part_name: input.part_name.clone(),
        base_filament_cost_cents,
        failure_buffer_cost_cents,
        machine_time_cost_cents,
        reprint_drain_cents,
        reprint_grams,
        total_part_cost_cents,
    }
}

/// Inputs for full order profitability and margin reporting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderEconomicsInput {
    pub order_id: String,
    pub order_code: String,
    pub subtotal_cents: i64,
    pub shipping_charged_cents: i64,
    pub box_cost_cents: i64,
    pub shipping_label_cost_cents: i64,
    pub parts: Vec<PartCostInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderEconomicsReport {
    pub order_id: String,
    pub order_code: String,
    pub gross_revenue_cents: i64,
    pub total_part_cost_cents: i64,
    pub total_reprint_drain_cents: i64,
    pub total_reprint_grams: f64,
    pub packaging_and_postage_cents: i64,
    pub net_profit_cents: i64,
    pub margin_pct: f64,
    /// Compact one-line summary for the Order Detail drawer
    /// (e.g. "Paid $40.89 · Filament & reprints $1.95 · Shipping $9.75 · Net $29.19").
    pub drawer_financial_line: String,
    /// Exception-only badge shown on the Order card ONLY when failed reprints or shipping deficit
    /// abnormally eroded margin on this specific order (`None` during normal operations).
    pub exception_badge: Option<String>,
    /// True if reprints or shipping deficit pushed net margin below 35%.
    pub margin_warning: bool,
    pub part_breakdowns: Vec<PartCostBreakdown>,
}

pub fn evaluate_order_economics(input: &OrderEconomicsInput) -> OrderEconomicsReport {
    let part_breakdowns: Vec<PartCostBreakdown> =
        input.parts.iter().map(compute_part_cost).collect();

    let total_part_cost_cents: i64 = part_breakdowns
        .iter()
        .map(|p| p.total_part_cost_cents)
        .sum();
    let total_reprint_drain_cents: i64 =
        part_breakdowns.iter().map(|p| p.reprint_drain_cents).sum();
    let total_reprint_grams: f64 = part_breakdowns.iter().map(|p| p.reprint_grams).sum();

    let gross_revenue_cents = input.subtotal_cents + input.shipping_charged_cents;
    let packaging_and_postage_cents = input.box_cost_cents + input.shipping_label_cost_cents;
    let net_profit_cents =
        gross_revenue_cents - total_part_cost_cents - packaging_and_postage_cents;

    let margin_pct = if gross_revenue_cents > 0 {
        ((net_profit_cents as f64) / (gross_revenue_cents as f64)) * 100.0
    } else {
        0.0
    };

    let drawer_financial_line = format!(
        "Paid ${:.2} · Filament & reprints ${:.2} · Shipping ${:.2} · Net ${:.2}",
        (gross_revenue_cents as f64) / 100.0,
        (total_part_cost_cents as f64) / 100.0,
        (packaging_and_postage_cents as f64) / 100.0,
        (net_profit_cents as f64) / 100.0,
    );

    let exception_badge = if total_reprint_drain_cents > 0 {
        Some(format!(
            "-${:.2} reprints ({:.0}g)",
            (total_reprint_drain_cents as f64) / 100.0,
            total_reprint_grams
        ))
    } else if packaging_and_postage_cents > input.shipping_charged_cents
        && input.shipping_charged_cents > 0
    {
        let diff = packaging_and_postage_cents - input.shipping_charged_cents;
        Some(format!("-${:.2} shipping", (diff as f64) / 100.0))
    } else {
        None
    };

    let margin_warning = margin_pct < 35.0 || exception_badge.is_some();

    OrderEconomicsReport {
        order_id: input.order_id.clone(),
        order_code: input.order_code.clone(),
        gross_revenue_cents,
        total_part_cost_cents,
        total_reprint_drain_cents,
        total_reprint_grams,
        packaging_and_postage_cents,
        net_profit_cents,
        margin_pct,
        drawer_financial_line,
        exception_badge,
        margin_warning,
        part_breakdowns,
    }
}

/// Queue-based ship-by promise forecast for an order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueueForecastInput {
    pub order_id: String,
    pub remaining_print_hours_ahead: f64,
    pub order_remaining_print_hours: f64,
    pub active_printers: u32,
    pub daily_run_hours: f64,
    pub promised_business_days: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueueForecast {
    pub order_id: String,
    pub queue_hours_ahead: f64,
    pub estimated_days_to_complete: f64,
    pub promised_business_days: f64,
    pub at_risk: bool,
    pub status_label: String,
}

pub fn forecast_order_lead_time(input: &QueueForecastInput) -> QueueForecast {
    let printers = input.active_printers.max(1) as f64;
    let daily_hours = if input.daily_run_hours > 0.0 {
        input.daily_run_hours
    } else {
        16.0
    };
    let total_hours =
        (input.remaining_print_hours_ahead + input.order_remaining_print_hours).max(0.0);
    let wall_clock_hours = total_hours / printers;
    let estimated_days = wall_clock_hours / daily_hours;
    let at_risk = estimated_days > input.promised_business_days;

    let status_label = if at_risk {
        format!(
            "At Risk · {:.1}d est vs {:.0}d promise",
            estimated_days, input.promised_business_days
        )
    } else {
        format!("On Track · {:.1}d est", estimated_days)
    };

    QueueForecast {
        order_id: input.order_id.clone(),
        queue_hours_ahead: input.remaining_print_hours_ahead,
        estimated_days_to_complete: estimated_days,
        promised_business_days: input.promised_business_days,
        at_risk,
        status_label,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_order_drawer_line_and_keeps_normal_card_badge_empty() {
        let report = evaluate_order_economics(&OrderEconomicsInput {
            order_id: "ord-1".to_string(),
            order_code: "FP-48HG-M2DT".to_string(),
            subtotal_cents: 3000,
            shipping_charged_cents: 1089,
            box_cost_cents: 85,
            shipping_label_cost_cents: 890,
            parts: vec![PartCostInput {
                part_id: "p1".to_string(),
                part_name: "Body".to_string(),
                filament_grams: 42.0,
                spool_price_cents: 2200,
                spool_weight_grams: 1000.0,
                failure_buffer_pct: 0.05,
                print_hours: 1.5,
                machine_hourly_rate_cents: 65,
                failed_reprint_count: 0,
            }],
        });

        assert_eq!(report.gross_revenue_cents, 4089);
        assert!(report.net_profit_cents > 2800);
        assert!(report
            .drawer_financial_line
            .starts_with("Paid $40.89 · Filament & reprints"));
        assert!(report.exception_badge.is_none());
        assert!(!report.margin_warning);
    }

    #[test]
    fn flags_at_risk_orders_when_queue_exceeds_promise() {
        let forecast = forecast_order_lead_time(&QueueForecastInput {
            order_id: "ord-2".to_string(),
            remaining_print_hours_ahead: 95.0,
            order_remaining_print_hours: 6.0,
            active_printers: 2,
            daily_run_hours: 12.0,
            promised_business_days: 3.0,
        });
        assert!(forecast.at_risk);
        assert!(forecast.status_label.starts_with("At Risk"));
    }
}
