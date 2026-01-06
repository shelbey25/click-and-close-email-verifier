import express, { Request, Response } from "express";
import dns from "dns";
import net from "net";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const SMTP_TIMEOUT_MS = 15000;

const SMTP_PORT = Number(process.env.SMTP_PORT) || 25;
const HELLO_DOMAIN = process.env.HELLO_DOMAIN || "example.com";
const PROBE_SENDER = process.env.PROBE_SENDER || "verify@example.com";

// Basic email regex (good enough for pre-check; SMTP is the real test)
const EMAIL_REGEX =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmailFormatValid(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

function getDomain(email: string): string {
  return email.split("@")[1];
}

function resolveMx(domain: string): Promise<dns.MxRecord[]> {
  return new Promise((resolve, reject) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err) return reject(err);
      if (!addresses || addresses.length === 0) {
        return reject(new Error("No MX records"));
      }
      // Sort by priority (lowest first)
      addresses.sort((a, b) => a.priority - b.priority);
      resolve(addresses);
    });
  });
}

type SmtpResult = {
  success: boolean;
  code?: number;
  message?: string;
};

function smtpVerifyMailbox(
  mxHost: string,
  targetEmail: string
): Promise<SmtpResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection(SMTP_PORT, mxHost);
    let dataBuffer = "";
    let step = 0;
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        socket.destroy();
        resolve({ success: false, message: "Timeout" });
      }
    }, SMTP_TIMEOUT_MS);

    function send(cmd: string) {
      socket.write(cmd + "\r\n");
    }

    function parseCode(line: string): number | undefined {
      const m = line.match(/^(\d{3})/);
      return m ? parseInt(m[1], 10) : undefined;
    }

    socket.on("data", (chunk) => {
      dataBuffer += chunk.toString();
      if (!dataBuffer.endsWith("\r\n")) return;

      const lines = dataBuffer
        .split("\r\n")
        .filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      const code = parseCode(lastLine);

      dataBuffer = "";

      if (code === undefined) return;

      if (step === 0) {
        // Server greeting (expect 220)
        if (code >= 400) {
          finished = true;
          clearTimeout(timeout);
          socket.end("QUIT\r\n");
          return resolve({ success: false, code, message: lastLine });
        }
        send(`HELO ${HELLO_DOMAIN}`);
        step = 1;
        return;
      }

      if (step === 1) {
        // After HELO
        if (code >= 400) {
          finished = true;
          clearTimeout(timeout);
          socket.end("QUIT\r\n");
          return resolve({ success: false, code, message: lastLine });
        }
        send(`MAIL FROM:<${PROBE_SENDER}>`);
        step = 2;
        return;
      }

      if (step === 2) {
        // After MAIL FROM
        if (code >= 400) {
          finished = true;
          clearTimeout(timeout);
          socket.end("QUIT\r\n");
          return resolve({ success: false, code, message: lastLine });
        }
        send(`RCPT TO:<${targetEmail}>`);
        step = 3;
        return;
      }

      if (step === 3) {
        // After RCPT TO: this is where we decide
        finished = true;
        clearTimeout(timeout);
        send("QUIT");

        if (code >= 200 && code < 300) {
          // 250 etc. -> mailbox accepted
          socket.end();
          return resolve({ success: true, code, message: lastLine });
        } else if (code >= 500 && code < 600) {
          // 550 etc. -> mailbox rejected
          socket.end();
          return resolve({ success: false, code, message: lastLine });
        } else {
          // 4xx or weird response -> unknown
          socket.end();
          return resolve({ success: false, code, message: lastLine });
        }
      }
    });

    socket.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ success: false, message: err.message });
    });

    socket.on("end", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ success: false, message: "Connection ended unexpectedly" });
    });
  });
}

async function verifyEmail(email: string) {
  if (!isEmailFormatValid(email)) {
    return {
      status: "invalid_format" as const,
      valid: false,
      reason: "Invalid email syntax",
    };
  }

  const domain = getDomain(email);

  let mxRecords: dns.MxRecord[];
  try {
    mxRecords = await resolveMx(domain);
  } catch (err: any) {
    return {
      status: "no_mx" as const,
      valid: false,
      reason: `Domain has no MX: ${err?.message || String(err)}`,
    };
  }

  // Try MX records in order until one gives a clear answer
  for (const mx of mxRecords) {
    const host = mx.exchange;
    const result = await smtpVerifyMailbox(host, email);

    if (result.success && result.code && result.code >= 200 && result.code < 300) {
      return {
        status: "deliverable" as const,
        valid: true,
        smtpHostTried: host,
        smtpCode: result.code,
        smtpMessage: result.message,
      };
    }

    if (result.code && result.code >= 500 && result.code < 600) {
      // Hard failure from this host
      return {
        status: "undeliverable" as const,
        valid: false,
        smtpHostTried: host,
        smtpCode: result.code,
        smtpMessage: result.message,
      };
    }

    // For 4xx / timeouts / unknown, move to next MX
  }

  // If all MX hosts are inconclusive
  return {
    status: "unknown" as const,
    valid: false,
    reason: "All MX hosts returned temporary or ambiguous responses",
  };
}

// POST /verify { "email": "user@example.com" }
app.post("/verify", async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || "").trim();

    if (!email) {
      return res.status(400).json({ error: "Missing email field" });
    }

    const result = await verifyEmail(email);
    res.json({
      email,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({
      error: "Internal error",
      details: err?.message || String(err),
    });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Email verifier API listening on http://localhost:${PORT}`);
});
