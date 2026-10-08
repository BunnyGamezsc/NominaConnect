import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DNS_RELAY } from "../src/tailscale-tailnet.js";

function probeTcp({ fragmentClient = false, fragmentUpstream = false }) {
  const probe = String.raw`
import threading
import time

question = b"\x03app\x05bunny\x08internal\x00\x00\x01\x00\x01"
query = struct.pack("!HHHHHH", 7, 0x0100, 1, 0, 0, 0) + question
response = struct.pack("!HHHHHH", 7, 0x8180, 1, 1, 0, 0) + question + b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + bytes([192,168,1,86])
expected = response[:-4] + bytes([100,70,80,90])

def read_frame(peer):
    data = b""
    while len(data) < 2:
        part = peer.recv(2 - len(data))
        assert part, "relay closed before answering the DNS request"
        data += part
    size = struct.unpack("!H", data)[0]
    data = b""
    while len(data) < size:
        part = peer.recv(size - len(data))
        assert part, "relay returned a truncated DNS frame"
        data += part
    return data

upstream_listener = socket.socket()
upstream_listener.bind(("127.0.0.1", 0))
upstream_listener.listen()
upstream_listener.settimeout(2)
connect = socket.create_connection
socket.create_connection = lambda address, **kwargs: connect(upstream_listener.getsockname() if address == (upstream_ip, 53) else address, **kwargs)
errors = []
def respond():
    try:
        peer, _ = upstream_listener.accept()
        with peer:
            peer.settimeout(2)
            assert read_frame(peer) == query
            frame = struct.pack("!H", len(response)) + response
            if fragment_upstream:
                peer.sendall(frame[:1])
                time.sleep(0.1)
                peer.sendall(frame[1:])
            else:
                peer.sendall(frame)
    except Exception as error:
        errors.append(error)

worker = threading.Thread(target=respond, daemon=True)
worker.start()
relay = TCP(("127.0.0.1", 0), TCPHandler)
thread = threading.Thread(target=relay.serve_forever, daemon=True)
thread.start()
try:
    with connect(relay.server_address, timeout=2) as peer:
        frame = struct.pack("!H", len(query)) + query
        if fragment_client:
            peer.sendall(frame[:1])
            time.sleep(0.1)
            peer.sendall(frame[1:])
        else:
            peer.sendall(frame)
        assert read_frame(peer) == expected, "managed proxy answer was not rewritten"
    worker.join(2)
    assert not errors, errors
finally:
    relay.shutdown()
    relay.server_close()
    upstream_listener.close()
`;
  const result = spawnSync("python3", ["-c", DNS_RELAY.split("import threading")[0] +
    `\nfragment_client = ${fragmentClient ? "True" : "False"}\nfragment_upstream = ${fragmentUpstream ? "True" : "False"}\n` + probe,
  "100.70.80.90", "127.0.0.1", "192.168.1.86", "bunny.internal"], { encoding: "utf8", timeout: 8000 });
  assert.equal(result.status, 0, result.stderr);
}

test("tailnet DNS accepts a TCP query whose length header arrives in separate writes", () => {
  probeTcp({ fragmentClient: true });
});

test("tailnet DNS accepts an upstream TCP answer with a fragmented length header", () => {
  probeTcp({ fragmentUpstream: true });
});
