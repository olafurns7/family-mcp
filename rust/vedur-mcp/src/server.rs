use mcp_runtime::{Cancelled, Fail, Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::http::Http;
use crate::input::{self, Call};
use crate::output::{CANCELLED, Output, fetch_failure};
use crate::{alerts, forecast, observations, stations, watch};

const JSON: &str = "application/json";

const RSS: &str = "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8";

pub struct Vedur {
    surface: Surface,
    http: Http,
}

impl Vedur {
    pub fn new() -> reqwest::Result<Self> {
        Ok(Self {
            surface: Surface::parse(include_str!("surface.json")),
            http: Http::new()?,
        })
    }

    async fn run(&self, call: Call) -> Output {
        match call {
            Call::SearchStations { query, active } => {
                let url = stations::url(&query, active);
                let fetched = self
                    .http
                    .get(&url, JSON, stations::MAX_BYTES)
                    .await
                    .map_err(|error| fetch_failure(error, stations::REFUSED))?;
                stations::shape(&fetched, &url, &query, active)
            }
            Call::Forecast { station_id, days } => {
                let url = forecast::url(station_id);
                let fetched = self
                    .http
                    .get(&url, JSON, forecast::MAX_BYTES)
                    .await
                    .map_err(|error| fetch_failure(error, forecast::REFUSED))?;
                forecast::shape(&fetched, &url, station_id, days)
            }
            Call::Observations { station_id } => {
                let failure = |error| fetch_failure(error, observations::REFUSED);
                let aws = self
                    .http
                    .get_or_no_data(
                        &observations::aws_url(station_id),
                        JSON,
                        observations::MAX_BYTES,
                    )
                    .await
                    .map_err(failure)?;
                let automatic = observations::record(aws.as_ref(), station_id)?;

                if automatic.is_some() {
                    return observations::shape(station_id, (aws.as_ref(), automatic), None);
                }
                let synop = self
                    .http
                    .get_or_no_data(
                        &observations::synop_url(station_id),
                        JSON,
                        observations::MAX_BYTES,
                    )
                    .await
                    .map_err(failure)?;
                let manned = observations::record(synop.as_ref(), station_id)?;
                observations::shape(
                    station_id,
                    (aws.as_ref(), None),
                    Some((synop.as_ref(), manned)),
                )
            }
            Call::Alerts { area_id, english } => {
                // Every failure, a refusal included, says that warnings may exist.
                let fetched = self
                    .http
                    .get(&alerts::url(), JSON, alerts::MAX_BYTES)
                    .await
                    .map_err(|_| alerts::FAILED)?;
                alerts::shape(&fetched, area_id, english, crate::http::now())
            }
            Call::Watch { limit } => {
                let fetched = self
                    .http
                    .get(&watch::url(), RSS, watch::MAX_BYTES)
                    .await
                    .map_err(|error| fetch_failure(error, watch::REFUSED))?;
                watch::shape(&fetched, limit)
            }
        }
    }
}

impl Server for Vedur {
    type Fail = Fail;

    const NAME: &'static str = "vedur-mcp";

    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    fn surface(&self) -> &Surface {
        &self.surface
    }

    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
        cancelled: Cancelled,
    ) -> Result<Result<Value, Fail>, String> {
        let call = input::parse(name, arguments)?;

        Ok(tokio::select! {
            output = self.run(call) => output,
            () = cancelled => Err(CANCELLED),
        })
    }
}
