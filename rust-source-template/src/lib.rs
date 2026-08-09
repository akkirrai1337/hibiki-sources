use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub use beakokit_html_sdk::{host_get_request, normalize_status, normalize_type, parse_year, HostResponse, HtmlDocument, HtmlSdkError, JsonDocument, JsonSdkError, HttpSdkError};

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
#[allow(dead_code)]

#[derive(Deserialize)]
enum RuntimeOperation {
    #[serde(rename = "SEARCH")]
    Search,
    #[serde(rename = "DETAILS")]
    Details,
    #[serde(rename = "PLAYBACK_GROUPS")]
    PlaybackGroups,
    #[serde(rename = "PLAYER_LINKS")]
    PlayerLinks,
}

#[derive(Deserialize)]
struct RuntimeRequest {
    #[serde(rename = "requestId")]
    request_id: String,
    operation: RuntimeOperation,
    payload: Value,
}

#[derive(Serialize)]
struct RuntimeResponse {
    #[serde(rename = "requestId")]
    request_id: String,
    payload: Option<Value>,
    #[serde(rename = "errorCode")]
    error_code: Option<&'static str>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
}

/// Perform an HTTPS request through the host permission boundary.
#[allow(dead_code)]
fn host_http(request_id: &str, url: &str) -> Result<String, String> {
    let request = host_get_request(request_id, url, json!({ "Accept": "application/json" }), 8 * 1024 * 1024);
    let bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let packed = unsafe { host_call(bytes.as_ptr(), bytes.len() as i32) };
    if packed < 0 {
        return Err("host request failed".to_owned());
    }
    let pointer = (packed as u64 >> 32) as usize;
    let length = (packed as u64 & u32::MAX as u64) as usize;
    let response = unsafe { core::slice::from_raw_parts(pointer as *const u8, length) };
    let response: Value = serde_json::from_slice(response).map_err(|error| error.to_string())?;
    HostResponse::from_value_limited(&response, "template source", 8 * 1024 * 1024)
        .map(|response| response.body().to_owned())
        .map_err(|error| format!("template HTTP response invalid: {error:?}"))
}

fn execute(request: RuntimeRequest) -> Result<Value, String> {
    match request.operation {
        RuntimeOperation::Search => {
            // Replace this with the source's catalog request and canonical mapper.
            let _ = request.payload;
            Err("source SEARCH is not implemented".to_owned())
        }
        RuntimeOperation::Details => Err("source DETAILS is not implemented".to_owned()),
        RuntimeOperation::PlaybackGroups => Err("source playback is not implemented".to_owned()),
        RuntimeOperation::PlayerLinks => Err("source playback is not implemented".to_owned()),
    }
}

fn error_response(request_id: String, message: impl Into<String>) -> Vec<u8> {
    serde_json::to_vec(&RuntimeResponse {
        request_id,
        payload: None,
        error_code: Some("SOURCE_FAILURE"),
        error_message: Some(message.into()),
        protocol_version: RUNTIME_PROTOCOL_VERSION,
    })
    .unwrap()
}

static mut HEAP: usize = 4096;

#[no_mangle]
pub extern "C" fn beakokit_reset() {
    unsafe {
        HEAP = 4096;
    }
}

#[no_mangle]
pub extern "C" fn beakokit_alloc(length: i32) -> i32 {
    unsafe {
        let pointer = HEAP;
        HEAP += length.max(0) as usize;
        pointer as i32
    }
}

#[no_mangle]
pub extern "C" fn beakokit_call(pointer: i32, length: i32) -> i64 {
    let request =
        unsafe { core::slice::from_raw_parts(pointer as *const u8, length.max(0) as usize) };
    let response = match serde_json::from_slice::<RuntimeRequest>(request) {
        Ok(request) => {
            let request_id = request.request_id.clone();
            match execute(request) {
                Ok(payload) => serde_json::to_vec(&RuntimeResponse {
                    request_id,
                    payload: Some(payload),
                    error_code: None,
                    error_message: None,
                    protocol_version: RUNTIME_PROTOCOL_VERSION,
                })
                .unwrap(),
                Err(error) => error_response(request_id, error),
            }
        }
        Err(error) => error_response("invalid-request".to_owned(), error.to_string()),
    };
    let response_pointer = beakokit_alloc(response.len() as i32) as usize;
    unsafe {
        core::ptr::copy_nonoverlapping(
            response.as_ptr(),
            response_pointer as *mut u8,
            response.len(),
        );
    }
    ((response_pointer as u64) << 32 | response.len() as u64) as i64
}

#[link(wasm_import_module = "host")]
extern "C" {
    #[link_name = "call"]
    #[allow(dead_code)]
    fn host_call(pointer: *const u8, length: i32) -> i64;
}
