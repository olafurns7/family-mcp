use mcp_runtime::{Cancelled, Fail, Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::http::{Fetched, Http};
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

    /// Caches the responses behind a successful output; one that did not read is fetched again.
    fn kept(&self, output: Output, read: &[&Fetched]) -> Output {
        if output.is_ok() {
            for fetched in read {
                self.http.keep(fetched);
            }
        }
        output
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
                self.kept(stations::shape(&fetched, &url, &query, active), &[&fetched])
            }
            Call::Forecast { station_id, days } => {
                let url = forecast::url(station_id);
                let fetched = self
                    .http
                    .get(&url, JSON, forecast::MAX_BYTES)
                    .await
                    .map_err(|error| fetch_failure(error, forecast::REFUSED))?;
                self.kept(
                    forecast::shape(&fetched, &url, station_id, days),
                    &[&fetched],
                )
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
                    let output = observations::shape(station_id, (aws.as_ref(), automatic), None);
                    return self.kept(
                        output,
                        &[aws.as_ref()].into_iter().flatten().collect::<Vec<_>>(),
                    );
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
                let output = observations::shape(
                    station_id,
                    (aws.as_ref(), None),
                    Some((synop.as_ref(), manned)),
                );
                let read: Vec<&Fetched> = [aws.as_ref(), synop.as_ref()]
                    .into_iter()
                    .flatten()
                    .collect();
                self.kept(output, &read)
            }
            Call::Alerts { area_id, english } => {
                // Every failure, a refusal included, says that warnings may exist.
                let fetched = self
                    .http
                    .get(&alerts::url(), JSON, alerts::MAX_BYTES)
                    .await
                    .map_err(|_| alerts::FAILED)?;
                let output = alerts::shape(&fetched, area_id, english, crate::http::now());
                self.kept(output, &[&fetched])
            }
            Call::Watch { limit } => {
                let fetched = self
                    .http
                    .get(&watch::url(), RSS, watch::MAX_BYTES)
                    .await
                    .map_err(|error| fetch_failure(error, watch::REFUSED))?;
                self.kept(watch::shape(&fetched, limit), &[&fetched])
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
