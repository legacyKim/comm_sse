require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 4000;

// 환경에 따른 CORS 설정
const corsOrigin =
  process.env.NODE_ENV === "production"
    ? "https://www.tokti.net"
    : ["https://www.tokti.net", "http://localhost:3000"];

app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "OPTIONS"],
    credentials: false,
    allowedHeaders: ["Content-Type", "Cache-Control"],
  })
);

const pool = new Pool({
  connectionString: process.env.DB_URL,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  // ssl: { rejectUnauthorized: false }, // 필요하면   추가
});

const clients = {};

// SSE 연결 공통 세팅 함수
function setupSSE(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // CORS 헤더 추가
  res.setHeader("Access-Control-Allow-Origin", "https://www.tokti.net");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Access-Control-Allow-Headers", "Cache-Control");

  res.flushHeaders(); // 헤더 바로 전송

  // 연결 유지를 위한 빈 데이터 주기적 전송 (30초마다)
  const keepAliveInterval = setInterval(() => {
    res.write(":\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAliveInterval);
  });

  return () => {
    clearInterval(keepAliveInterval);
    res.end();
  };
}

app.get("/events/:url_slug", async (req, res) => {
  const { url_slug } = req.params;
  const client = await pool.connect();

  client.on("error", (err) => {
    console.error("Postgres client error:", err);
  });

  await client.query("LISTEN post_trigger");

  // SSE 공통 처리
  const closeSSE = setupSSE(req, res);

  // 클라이언트 관리
  if (!clients[url_slug]) clients[url_slug] = [];
  clients[url_slug].push(res);

  const notify = (msg) => {
    try {
      const data = JSON.parse(msg.payload);
      if (data.url_slug === url_slug) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    } catch (err) {
      // JSON 파싱 실패 무시
    }
  };

  client.on("notification", notify);

  req.on("close", () => {
    client.removeListener("notification", notify);
    clients[url_slug] = clients[url_slug].filter((r) => r !== res);

    if (clients[url_slug].length === 0) {
      client.query("UNLISTEN post_trigger");
      client.release();
      delete clients[url_slug];
    }

    closeSSE();
  });

  res.on("error", (err) => {
    console.error("Response error:", err);
  });
});

// comments 스트림
app.get("/comments/stream", async (req, res) => {
  console.log("comments stream 연결됨");
  const disconnect = setupSSE(req, res);

  // 즉시 연결 확인 메시지 전송
  res.write(
    `data: ${JSON.stringify({
      event: "connected",
      message: "SSE 연결 성공",
    })}\n\n`
  );

  let client;
  try {
    client = await pool.connect();
    console.log("Postgres client 연결됨");

    client.on("error", (err) => {
      console.error("Postgres client error:", err);
    });

    await client.query("LISTEN comment_events");
    console.log("LISTEN comment_events 실행 완료");

    const notify = (msg) => {
      console.log("=== comment_events 알림 수신 ===");
      console.log("Channel:", msg.channel);
      console.log("Payload:", msg.payload);
      console.log("Raw message:", msg);

      if (msg.channel === "comment_events") {
        try {
          console.log("알림 데이터 처리 시작:", msg.payload);
          // JSON 형식인지 확인하고 파싱
          const data =
            typeof msg.payload === "string"
              ? JSON.parse(msg.payload)
              : msg.payload;

          console.log("파싱된 데이터:", data);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
          console.log("클라이언트로 데이터 전송 완료");
        } catch (err) {
          console.error("JSON 파싱 오류:", err);
          console.error("파싱 실패한 payload:", msg.payload);
          // 파싱 실패시 빈 객체 전송
          res.write(`data: {}\n\n`);
        }
      }
    };

    client.on("notification", notify);
    console.log("알림 리스너 등록됨");
  } catch (err) {
    console.error("PostgreSQL 연결 또는 LISTEN 설정 오류:", err);
    res.write(
      `data: ${JSON.stringify({ event: "error", message: "DB 연결 오류" })}\n\n`
    );
  }

  req.on("close", () => {
    console.log("클라이언트 연결 해제");
    try {
      if (client) {
        client.removeListener("notification", notify);
        client.release();
      }
      disconnect();
    } catch (err) {
      console.error("연결 해제 중 오류:", err);
    }
  });

  res.on("error", (err) => {
    console.error("Response error:", err);
    try {
      if (client) {
        client.removeListener("notification", notify);
        client.release();
      }
      disconnect();
    } catch (releaseErr) {
      console.error("오류 발생 후 정리 중 오류:", releaseErr);
    }
  });
});

// notifications 스트림 (예: 특정 유저 알림)
app.get("/notifications/stream/:userId", async (req, res) => {
  const userId = req.params.userId;

  if (!userId) {
    res.status(400).end("Missing userId query param");
    return;
  }

  const disconnect = setupSSE(req, res);
  const client = await pool.connect();

  client.on("error", (err) => {
    console.error("Postgres client error:", err);
  });

  await client.query("LISTEN new_notification");

  const notify = async (msg) => {
    if (msg.channel === "new_notification") {
      // 알림 중 가장 최근 것 하나만 전송
      const result = await pool.query(
        `SELECT * FROM notifications WHERE receiver_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      const latest = result.rows[0];
      if (latest) {
        res.write(`data: ${JSON.stringify(latest)}\n\n`);
      }
    }
  };

  client.on("notification", notify);

  req.on("close", () => {
    client.removeListener("notification", notify);
    client.release();
    disconnect();
  });

  res.on("error", (err) => {
    console.error("Response error:", err);
  });
});

app.listen(PORT, () => {
  console.log(`✅ SSE 서버 실행 중 on port ${PORT}`);
});
