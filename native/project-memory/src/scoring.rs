// Derived from TraceDecay. Copyright (c) 2025 Enzo Lombardi. MIT, see ../LICENSE.
pub fn reinforcement(retrieval_count: u64) -> f64 {
    1.0 + (0.02 * (retrieval_count as f64).ln_1p()).min(0.50)
}

pub fn combined_score(
    fts: f64,
    jaccard: f64,
    holographic: f64,
    trust: f64,
    temporal_decay: f64,
    retrieval_count: u64,
) -> f64 {
    let relevance = fts.mul_add(0.40, jaccard.mul_add(0.30, holographic * 0.30));
    relevance
        * trust.clamp(0.0, 1.0)
        * temporal_decay.clamp(0.0, 1.0)
        * reinforcement(retrieval_count)
}

pub fn score_millionths(value: f64) -> u32 {
    (value.clamp(0.0, 1.5) * 1_000_000.0).round() as u32
}

pub fn temporal_decay(updated_at_ms: f64, now_ms: f64) -> f64 {
    if updated_at_ms <= 0.0 {
        return 1.0;
    }
    let age_micros = ((now_ms - updated_at_ms) * 1_000.0).max(0.0);
    let age_days = age_micros / 86_400_000_000.0;
    0.5_f64.powf(age_days / 365.0).clamp(0.10, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fused_arithmetic_preserves_millionth_ties() {
        let score = combined_score(
            0.6225797407729144,
            0.21927807219278073,
            0.61728394011,
            1.0,
            1.0,
            0,
        );
        assert_eq!(score.to_bits(), 0.5000005000000001_f64.to_bits());
        assert_eq!(score_millionths(score), 500_001);
    }

    #[test]
    fn age_and_reinforcement_are_bounded() {
        let year_ms = 365.0 * 86_400_000.0;
        assert_eq!(temporal_decay(1.0, 1.0 + year_ms), 0.5);
        assert_eq!(temporal_decay(1.0, 1.0 + year_ms * 100.0), 0.1);
        assert_eq!(temporal_decay(0.0, year_ms), 1.0);
        assert_eq!(temporal_decay(year_ms, 1.0), 1.0);
        assert_eq!(reinforcement(0), 1.0);
        assert_eq!(reinforcement(u64::MAX), 1.5);
        assert_eq!(
            score_millionths(combined_score(1.0, 1.0, 1.0, 1.0, 1.0, u64::MAX)),
            1_500_000
        );
    }
}
