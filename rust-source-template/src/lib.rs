use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub use beakokit_html_sdk::{host_get_request, normalize_status, normalize_type, parse_year, sanitize_runtime_error, unpack_host_response, validate_runtime_request, HostResponse, HtmlDocument, HtmlSdkError, JsonDocument, JsonSdkError, HttpSdkError, MAX_HOST_RESPONSE_BYTES, MAX_RUNTIME_REQUEST_BYTES, MAX_RUNTIME_RESPONSE_BYTES};

const RUNTIME_PROTOCOL_VERSION: u32 = 1;
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
    let response = unsafe { unpack_host_response(packed, "template source")? };
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
    let message = sanitize_runtime_error(&message.into());
    serde_json::to_vec(&RuntimeResponse {
        request_id,
        payload: None,
        error_code: Some("SOURCE_FAILURE"),
        error_message: Some(message),
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
        if length < 0 { return -1; }
        let pointer = HEAP;
        let Some(next) = HEAP.checked_add(length as usize) else { return -1; };
        if next > i32::MAX as usize { return -1; }
        HEAP = next;
        pointer as i32
    }
}

#[no_mangle]
pub extern "C" fn beakokit_call(pointer: i32, length: i32) -> i64 {
    if pointer < 0 || length < 0 || length as usize > MAX_RUNTIME_REQUEST_BYTES {
        return write_response(error_response("invalid-request".to_owned(), "runtime request pointer or size is invalid"));
    }
    let request = if length == 0 { &[] } else { unsafe { core::slice::from_raw_parts(pointer as *const u8, length as usize) } };
    let response = match serde_json::from_slice::<Value>(request)
        .map_err(|error| error.to_string())
        .and_then(|value| {
            let request_id = validate_runtime_request(&value)?;
            let mut request = serde_json::from_value::<RuntimeRequest>(value).map_err(|error| error.to_string())?;
            request.request_id = request_id;
            Ok(request)
        }) {
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
    write_response(response)
}

fn write_response(response: Vec<u8>) -> i64 {
    if response.len() > MAX_RUNTIME_RESPONSE_BYTES { return -1; }
    let response_pointer = beakokit_alloc(response.len() as i32);
    if response_pointer < 0 { return -1; }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocator_rejects_invalid_sizes() {
        beakokit_reset();
        assert_eq!(beakokit_alloc(-1), -1);
        assert!(beakokit_alloc(16) > 0);
    }

    #[test]
    fn allocator_rejects_pointer_overflow() {
        unsafe { HEAP = i32::MAX as usize - 1; }
        assert_eq!(beakokit_alloc(2), -1);
        beakokit_reset();
    }
}
