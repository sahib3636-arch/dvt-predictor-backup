/* Poll Worker — fetches feed.json every 2s in a background thread */
var pollUrl = '';
var pollTimer = null;

self.onmessage = function(e) {
  if (e.data && e.data.url) {
    pollUrl = e.data.url.replace(/\/+$/, '');
    if (pollTimer) clearInterval(pollTimer);
    doPoll();
    pollTimer = setInterval(doPoll, 2000);
  }
  if (e.data && e.data.kick) {
    doPoll();
  }
};

function doPoll() {
  if (!pollUrl) return;
  var url = pollUrl + '/feed.json?t=' + Date.now();
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 5000;
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var payload = JSON.parse(xhr.responseText);
          self.postMessage({ ok: true, payload: payload });
        } catch(e) {
          self.postMessage({ ok: false, payload: null });
        }
      } else {
        self.postMessage({ ok: false, payload: null });
      }
    };
    xhr.onerror = function() { self.postMessage({ ok: false, payload: null }); };
    xhr.ontimeout = function() { self.postMessage({ ok: false, payload: null }); };
    xhr.send();
  } catch(e) {
    self.postMessage({ ok: false, payload: null });
  }
}
