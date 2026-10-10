#!/usr/bin/env python3
"""Hostname-only Java server-list status and ping; this does not prove a join.

Protocol source: https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping
"""
import io
import json
import pathlib
import socket
import struct
import sys
import time


def varint(value):
    value &= 0xffffffff
    result = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        result.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(result)


def read_exact(stream, length):
    data = bytearray()
    while len(data) < length:
        chunk = stream.read(length - len(data))
        if not chunk:
            raise EOFError('Incomplete Minecraft response')
        data.extend(chunk)
    return bytes(data)


def read_varint(stream):
    value = 0
    for index in range(5):
        byte = read_exact(stream, 1)[0]
        value |= (byte & 0x7f) << (index * 7)
        if not byte & 0x80:
            return value
    raise ValueError('Invalid VarInt')


def send(sock, payload):
    sock.sendall(varint(len(payload)) + payload)


def receive(stream):
    length = read_varint(stream)
    if length > 1024 * 1024:
        raise ValueError('Oversized Minecraft response')
    return io.BytesIO(read_exact(stream, length))


if len(sys.argv) != 4:
    raise SystemExit('Usage: check-minecraft-status.py HOST EXPECTED_DNS_IP EVIDENCE_JSON')
host, expected, output = sys.argv[1:]
addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, 25565, socket.AF_INET, socket.SOCK_STREAM)})
assert addresses == [expected], addresses
with socket.create_connection((host, 25565), timeout=10) as sock:
    destination = sock.getpeername()[0]
    assert destination == expected
    hostname = host.encode('utf-8')
    send(sock, b'\x00' + varint(-1) + varint(len(hostname)) + hostname + struct.pack('>H', 25565) + b'\x01')
    send(sock, b'\x00')
    stream = sock.makefile('rb')
    packet = receive(stream)
    assert read_varint(packet) == 0
    status = json.loads(read_exact(packet, read_varint(packet)))
    assert status['version']['name'] == '1.21.11', status['version']
    timestamp = int(time.time() * 1000)
    started = time.monotonic()
    send(sock, b'\x01' + struct.pack('>q', timestamp))
    packet = receive(stream)
    assert read_varint(packet) == 1
    assert struct.unpack('>q', read_exact(packet, 8))[0] == timestamp
    evidence = {'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'hostname': host, 'resolution': addresses, 'destination': destination,
        'status': status, 'pingMs': round((time.monotonic() - started) * 1000, 2),
        'applicationJoinVerified': False}
    pathlib.Path(output).write_text(json.dumps(evidence, indent=2) + '\n')
    print('PASS:', host, 'Java 1.21.11 status/ping via', destination, '; player join remains unverified')
