let buffer = Buffer.alloc(0);

function send(message) {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function respond(message) {
	if (message.method === 'initialize') {
		if (!message.params?.capabilities?.textDocument?.diagnostic) {
			process.exit(2);
		}
		send({
			jsonrpc: '2.0',
			id: message.id,
			result: {
				capabilities: {
					textDocumentSync: { openClose: true, change: 1 },
					diagnosticProvider: {
						identifier: 'typescript',
						interFileDependencies: true,
						workspaceDiagnostics: false,
					},
				},
			},
		});
		return;
	}
	if (message.method === 'textDocument/diagnostic') {
		send({
			jsonrpc: '2.0',
			id: message.id,
			result: {
				kind: 'full',
				items: [
					{
						range: {
							start: { line: 1, character: 6 },
							end: { line: 1, character: 8 },
						},
						severity: 1,
						code: 2345,
						source: 'ts',
						message:
							"Argument of type 'number' is not assignable to parameter of type 'string'.",
					},
				],
			},
		});
		return;
	}
	if (message.method === 'shutdown') {
		send({ jsonrpc: '2.0', id: message.id, result: null });
	}
}

process.stdin.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const header_end = buffer.indexOf('\r\n\r\n');
		if (header_end === -1) return;
		const header = buffer.subarray(0, header_end).toString('ascii');
		const match = header.match(/Content-Length:\s*(\d+)/i);
		if (!match) throw new Error('Missing Content-Length header');
		const length = Number(match[1]);
		const body_start = header_end + 4;
		if (buffer.length < body_start + length) return;
		const message = JSON.parse(
			buffer.subarray(body_start, body_start + length).toString('utf8'),
		);
		buffer = buffer.subarray(body_start + length);
		respond(message);
	}
});
