// Derived from TraceDecay. Copyright (c) 2025 Enzo Lombardi. MIT, see ../LICENSE.
pub mod encoding;
mod scoring;

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use encoding::HolographicEncoder;
use napi::bindgen_prelude::*;
use napi_derive::napi;

const MAX_BATCH: usize = 32;
const MAX_TEXT_BYTES: usize = 16_384;
const MAX_ENTITIES: usize = 64;
const MAX_BATCH_BYTES: usize = 131_072;
const MAX_IN_FLIGHT: usize = 2;
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

#[napi(object)]
pub struct Candidate {
    pub content: String,
    pub entities: Vec<String>,
    pub fts: f64,
    pub jaccard: f64,
    pub trust: f64,
    pub updated_at: f64,
    pub retrieval_count: f64,
}

#[napi(object)]
pub struct Evidence {
    pub raw_cosine: f64,
    pub holographic: f64,
    pub decay: f64,
    pub reinforcement: f64,
    pub score: f64,
    pub score_millionths: u32,
}

struct Admission;
impl Admission {
    fn acquire() -> Result<Self> {
        IN_FLIGHT
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_IN_FLIGHT).then_some(count + 1)
            })
            .map(|_| Self)
            .map_err(|_| Error::new(Status::QueueFull, "holographic batch capacity reached"))
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct RankTask {
    query: String,
    search_tokens: Vec<String>,
    candidates: Vec<Candidate>,
    now: f64,
    cancelled: Arc<AtomicBool>,
    _admission: Admission,
}

impl Task for RankTask {
    type Output = Vec<Evidence>;
    type JsValue = Vec<Evidence>;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(Status::Cancelled, "holographic batch cancelled"));
        }
        let encoder = HolographicEncoder::new();
        let vector = encoder
            .encode_fact(&self.query, &self.search_tokens)
            .map_err(native_error)?;
        let query = encoder.prepare_query(&vector).map_err(native_error)?;
        self.candidates
            .iter()
            .map(|candidate| {
                if self.cancelled.load(Ordering::Relaxed) {
                    return Err(Error::new(Status::Cancelled, "holographic batch cancelled"));
                }
                let vector = encoder
                    .encode_fact(&candidate.content, &candidate.entities)
                    .map_err(native_error)?;
                let raw_cosine = encoder
                    .query_similarity(&query, &vector)
                    .map_err(native_error)?;
                let holographic = raw_cosine.midpoint(1.0).clamp(0.0, 1.0);
                let decay = scoring::temporal_decay(candidate.updated_at, self.now);
                let retrieval_count = candidate.retrieval_count as u64;
                let score = scoring::combined_score(
                    candidate.fts,
                    candidate.jaccard,
                    holographic,
                    candidate.trust,
                    decay,
                    retrieval_count,
                );
                Ok(Evidence {
                    raw_cosine,
                    holographic,
                    decay,
                    reinforcement: scoring::reinforcement(retrieval_count),
                    score,
                    score_millionths: scoring::score_millionths(score),
                })
            })
            .collect()
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(Status::Cancelled, "holographic batch cancelled"));
        }
        Ok(output)
    }
}

fn native_error(error: encoding::HolographicEncodingError) -> Error {
    Error::new(Status::InvalidArg, error.to_string())
}

fn validate_text(content: &str, entities: &[String]) -> Result<usize> {
    let bytes = content.len() + entities.iter().map(String::len).sum::<usize>();
    if bytes > MAX_TEXT_BYTES || entities.len() > MAX_ENTITIES {
        return Err(Error::new(
            Status::InvalidArg,
            "holographic text limit exceeded",
        ));
    }
    Ok(bytes)
}

#[napi]
pub fn rank_batch(
    query: String,
    search_tokens: Vec<String>,
    candidates: Vec<Candidate>,
    now: f64,
    signal: Option<AbortSignal>,
) -> Result<AsyncTask<RankTask>> {
    if candidates.len() > MAX_BATCH || !now.is_finite() {
        return Err(Error::new(Status::InvalidArg, "invalid holographic batch"));
    }
    let mut bytes = validate_text(&query, &search_tokens)?;
    for candidate in &candidates {
        bytes += validate_text(&candidate.content, &candidate.entities)?;
        if ![
            candidate.fts,
            candidate.jaccard,
            candidate.trust,
            candidate.updated_at,
            candidate.retrieval_count,
        ]
        .iter()
        .all(|value| value.is_finite())
            || candidate.retrieval_count < 0.0
            || candidate.retrieval_count > 9_007_199_254_740_991.0
            || candidate.retrieval_count.fract() != 0.0
        {
            return Err(Error::new(
                Status::InvalidArg,
                "invalid holographic score input",
            ));
        }
    }
    if bytes > MAX_BATCH_BYTES {
        return Err(Error::new(
            Status::InvalidArg,
            "holographic batch byte limit exceeded",
        ));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let cancelled = Arc::clone(&cancelled);
        signal.on_abort(move || cancelled.store(true, Ordering::Relaxed));
    }
    Ok(AsyncTask::with_optional_signal(
        RankTask {
            query,
            search_tokens,
            candidates,
            now,
            cancelled,
            _admission: Admission::acquire()?,
        },
        signal,
    ))
}

#[napi]
pub fn cosine(left: Float64Array, right: Float64Array) -> Result<f64> {
    HolographicEncoder::new()
        .similarity(left.as_ref(), right.as_ref())
        .map_err(native_error)
}

pub struct EncodeTask {
    content: String,
    entities: Vec<String>,
    _admission: Admission,
}
impl Task for EncodeTask {
    type Output = Vec<f64>;
    type JsValue = Float64Array;

    fn compute(&mut self) -> Result<Self::Output> {
        HolographicEncoder::new()
            .encode_fact(&self.content, &self.entities)
            .map_err(native_error)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Float64Array::new(output))
    }
}

#[napi]
pub fn encode_fact(content: String, entities: Vec<String>) -> Result<AsyncTask<EncodeTask>> {
    validate_text(&content, &entities)?;
    Ok(AsyncTask::new(EncodeTask {
        content,
        entities,
        _admission: Admission::acquire()?,
    }))
}
