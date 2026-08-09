pub use scraper::{ElementRef, Html, Selector};
use serde_json::Value;

pub const DEFAULT_MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct HtmlDocument {
    document: Html,
    base_url: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HtmlSdkError {
    InvalidSelector(String),
    MissingAttribute { selector: String, attribute: String },
    MissingText { selector: String },
    DocumentTooLarge { actual: usize, maximum: usize },
}

impl HtmlDocument {
    pub fn parse(html: &str, base_url: impl Into<String>) -> Self {
        Self { document: Html::parse_document(html), base_url: base_url.into() }
    }

    pub fn parse_limited(
        html: &str,
        base_url: impl Into<String>,
        maximum_bytes: usize,
    ) -> Result<Self, HtmlSdkError> {
        if html.len() > maximum_bytes {
            return Err(HtmlSdkError::DocumentTooLarge { actual: html.len(), maximum: maximum_bytes });
        }
        Ok(Self::parse(html, base_url))
    }

    pub fn select<'document>(
        &'document self,
        selector: &str,
    ) -> Result<Vec<ElementRef<'document>>, HtmlSdkError> {
        let selector = Selector::parse(selector)
            .map_err(|_| HtmlSdkError::InvalidSelector(selector.to_owned()))?;
        Ok(self.document.select(&selector).collect())
    }

    pub fn select_first<'document>(
        &'document self,
        selector: &str,
    ) -> Result<Option<ElementRef<'document>>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().next())
    }

    pub fn text(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().filter_map(clean_element_text).collect())
    }

    pub fn text_first(&self, selector: &str) -> Result<Option<String>, HtmlSdkError> {
        Ok(self.select_first(selector)?.and_then(clean_element_text))
    }

    pub fn text_any(&self, selectors: &[&str]) -> Result<Option<String>, HtmlSdkError> {
        for selector in selectors {
            if let Some(value) = self.text_first(selector)? {
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    pub fn required_text(&self, selector: &str) -> Result<String, HtmlSdkError> {
        self.text_first(selector)?.ok_or_else(|| HtmlSdkError::MissingText { selector: selector.to_owned() })
    }

    pub fn attributes(&self, selector: &str, attribute: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter()
            .filter_map(|element| element.value().attr(attribute).map(str::to_owned))
            .collect())
    }

    pub fn attributes_any(&self, selector: &str, attributes: &[&str]) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().filter_map(|element| {
            attributes.iter().find_map(|attribute| {
                element.value().attr(attribute).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
            })
        }).collect())
    }

    pub fn required_attribute(
        &self,
        selector: &str,
        attribute: &str,
    ) -> Result<Vec<String>, HtmlSdkError> {
        let selector_value = selector.to_owned();
        self.select(selector)?.into_iter().map(|element| {
            element.value().attr(attribute).map(str::to_owned).ok_or_else(|| {
                HtmlSdkError::MissingAttribute {
                    selector: selector_value.clone(),
                    attribute: attribute.to_owned(),
                }
            })
        }).collect()
    }

    pub fn links(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        self.attributes(selector, "href")
            .map(|values| values.into_iter().map(|value| self.absolute_url(&value)).collect())
    }

    pub fn image_urls(&self, selector: &str) -> Result<Vec<String>, HtmlSdkError> {
        Ok(self.select(selector)?.into_iter().filter_map(|element| {
            let value = ["src", "data-src", "data-original"]
                .into_iter().find_map(|attribute| element.value().attr(attribute).map(str::trim).filter(|value| !value.is_empty()))
                .or_else(|| element.value().attr("srcset").and_then(srcset_first));
            value.map(|value| self.absolute_url(value))
        }).collect())
    }

    pub fn absolute_url(&self, value: &str) -> String {
        let value = value.trim();
        if value.is_empty() || value.starts_with('#') || value.starts_with("data:") || value.starts_with("javascript:") {
            return value.to_owned();
        }
        if value.starts_with("http://") || value.starts_with("https://") { return value.to_owned(); }
        if value.starts_with("//") { return format!("https:{value}"); }
        let base = self.base_url.trim_end_matches('/');
        if value.starts_with('/') {
            let origin = base.split_once("//")
                .map(|(_, remainder)| remainder.split('/').next().unwrap_or(remainder))
                .unwrap_or(base);
            return format!("https://{origin}{value}");
        }
        format!("{base}/{value}")
    }
}

pub fn clean_element_text(element: ElementRef<'_>) -> Option<String> {
    let value = element.text().collect::<String>();
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then_some(value)
}

fn srcset_first(value: &str) -> Option<&str> {
    value.split(',').next()?.split_whitespace().next().filter(|value| !value.is_empty())
}

#[derive(Debug)]
pub struct JsonDocument { value: Value }

#[derive(Debug, PartialEq, Eq)]
pub enum JsonSdkError {
    InvalidJson(String),
    MissingValue { path: String },
    ExpectedString { path: String },
    ExpectedInteger { path: String },
    ExpectedBoolean { path: String },
    ExpectedArray { path: String },
    DocumentTooLarge { actual: usize, maximum: usize },
}

impl JsonDocument {
    pub fn parse(body: &str) -> Result<Self, JsonSdkError> {
        serde_json::from_str(body).map(|value| Self { value })
            .map_err(|error| JsonSdkError::InvalidJson(error.to_string()))
    }

    pub fn parse_limited(body: &str, maximum_bytes: usize) -> Result<Self, JsonSdkError> {
        if body.len() > maximum_bytes {
            return Err(JsonSdkError::DocumentTooLarge { actual: body.len(), maximum: maximum_bytes });
        }
        Self::parse(body)
    }

    pub fn value(&self, path: &str) -> Option<&Value> { self.value.pointer(path) }

    pub fn root(&self) -> &Value { &self.value }

    pub fn string(&self, path: &str) -> Result<String, JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_str().map(str::to_owned)
            .ok_or_else(|| JsonSdkError::ExpectedString { path: path.to_owned() })
    }

    pub fn int(&self, path: &str) -> Result<i64, JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_i64().ok_or_else(|| JsonSdkError::ExpectedInteger { path: path.to_owned() })
    }

    pub fn boolean(&self, path: &str) -> Result<bool, JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_bool().ok_or_else(|| JsonSdkError::ExpectedBoolean { path: path.to_owned() })
    }

    pub fn array(&self, path: &str) -> Result<&[Value], JsonSdkError> {
        let value = self.value(path).ok_or_else(|| JsonSdkError::MissingValue { path: path.to_owned() })?;
        value.as_array().map(Vec::as_slice).ok_or_else(|| JsonSdkError::ExpectedArray { path: path.to_owned() })
    }

    pub fn html(&self, path: &str, base_url: impl Into<String>) -> Result<HtmlDocument, JsonSdkError> {
        let html = self.string(path)?;
        Ok(HtmlDocument::parse(&html, base_url))
    }
}

#[cfg(test)]
mod tests {
    use super::{HtmlDocument, HtmlSdkError, JsonDocument, JsonSdkError};

    #[test]
    fn parses_cards_and_resolves_urls() {
        let document = HtmlDocument::parse(
            r#"<article class="card"><a href="/anime/test"> Test&nbsp; show </a><img data-src="//cdn.example/test.jpg"></article>"#,
            "https://example.org/catalog",
        );
        assert_eq!(document.text(".card a").unwrap(), ["Test show"]);
        assert_eq!(document.links(".card a").unwrap(), ["https://example.org/anime/test"]);
        assert_eq!(document.image_urls(".card img").unwrap(), ["https://cdn.example/test.jpg"]);
        assert_eq!(document.attributes_any(".card img", &["data-missing", "data-src"]).unwrap(), ["//cdn.example/test.jpg"]);
        let srcset = HtmlDocument::parse(r#"<img srcset="/small.jpg 480w, /large.jpg 960w">"#, "https://example.org");
        assert_eq!(srcset.image_urls("img").unwrap(), ["https://example.org/small.jpg"]);
    }

    #[test]
    fn reports_selector_and_required_field_errors() {
        let document = HtmlDocument::parse(r#"<article class="card"></article>"#, "https://example.org");
        assert_eq!(document.text(".card[").unwrap_err(), HtmlSdkError::InvalidSelector(".card[".to_owned()));
        assert_eq!(document.required_attribute(".card", "data-id").unwrap_err(), HtmlSdkError::MissingAttribute {
            selector: ".card".to_owned(), attribute: "data-id".to_owned()
        });
        assert_eq!(document.required_text(".card .title").unwrap_err(), HtmlSdkError::MissingText {
            selector: ".card .title".to_owned()
        });
    }

    #[test]
    fn parses_html_from_json_envelope() {
        let document = JsonDocument::parse(r#"{"data":{"content":"<div class=\"result\">OK</div>","count":2,"enabled":true,"items":[1]}}"#).unwrap();
        assert_eq!(document.html("/data/content", "https://example.org").unwrap().text(".result").unwrap(), ["OK"]);
        assert_eq!(document.int("/data/count").unwrap(), 2);
        assert!(document.boolean("/data/enabled").unwrap());
        assert_eq!(document.array("/data/items").unwrap().len(), 1);
        assert_eq!(document.string("/data/missing"), Err(JsonSdkError::MissingValue { path: "/data/missing".to_owned() }));
        assert_eq!(document.int("/data/missing"), Err(JsonSdkError::MissingValue { path: "/data/missing".to_owned() }));
    }

    #[test]
    fn rejects_documents_above_limits_before_parsing() {
        assert_eq!(
            HtmlDocument::parse_limited("12345", "https://example.org", 4).unwrap_err(),
            HtmlSdkError::DocumentTooLarge { actual: 5, maximum: 4 }
        );
        assert_eq!(
            JsonDocument::parse_limited("12345", 4).unwrap_err(),
            JsonSdkError::DocumentTooLarge { actual: 5, maximum: 4 }
        );
    }
}
