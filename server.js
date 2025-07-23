require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const redis = require("redis");

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
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
    allowedHeaders: ["Content-Type", "Cache-Control"],
  })
);

const pool = new Pool({
  connectionString: process.env.DB_URL,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  ssl: { rejectUnauthorized: false }, // Neon은 SSL 필요
});

// Redis 클라이언트 설정
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

const redisSubscriber = redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

// Redis 연결
(async () => {
  try {
    await redisClient.connect();
    await redisSubscriber.connect();
    console.log("✅ Redis 연결됨");
  } catch (err) {
    console.error("❌ Redis 연결 실패:", err);
  }
})();

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

// comments 스트림 - Redis pub/sub 방식
app.get("/comments/stream", async (req, res) => {
  console.log("comments stream 연결됨 (Redis 방식)");
  const disconnect = setupSSE(req, res);

  // 즉시 연결 확인 메시지 전송
  res.write(
    `data: ${JSON.stringify({
      event: "connected",
      message: "SSE 연결 성공 (Redis 모드)",
    })}\n\n`
  );

  let isActive = true;

  // Redis 메시지 리스너
  const messageHandler = (message) => {
    if (!isActive) return;

    try {
      console.log("Redis에서 댓글 알림 수신:", message);
      const data = JSON.parse(message);

      console.log("파싱된 데이터:", data);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      console.log("클라이언트로 데이터 전송 완료");
    } catch (err) {
      console.error("Redis 메시지 파싱 오류:", err);
    }
  };

  // Redis 구독 시작
  try {
    await redisSubscriber.subscribe("comment_events", messageHandler);
    console.log("Redis comment_events 채널 구독 시작");
  } catch (err) {
    console.error("Redis 구독 오류:", err);
    res.write(
      `data: ${JSON.stringify({
        event: "error",
        message: "Redis 구독 오류",
      })}\n\n`
    );
  }

  req.on("close", async () => {
    console.log("클라이언트 연결 해제 (Redis)");
    isActive = false;
    try {
      await redisSubscriber.unsubscribe("comment_events");
    } catch (err) {
      console.error("Redis 구독 해제 오류:", err);
    }
    disconnect();
  });

  res.on("error", async (err) => {
    console.error("Response error (Redis):", err);
    isActive = false;
    try {
      await redisSubscriber.unsubscribe("comment_events");
    } catch (unsubErr) {
      console.error("Redis 구독 해제 오류:", unsubErr);
    }
    disconnect();
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

// 테스트용 엔드포인트 - Redis로 알림 전송
app.get("/test/notify", async (req, res) => {
  try {
    console.log("Redis 테스트 알림 전송 시작");

    const testData = {
      id: 999,
      event: "INSERT",
      content: "테스트 댓글",
      user_nickname: "테스트유저",
      created_at: new Date().toISOString(),
    };

    console.log("Redis로 전송할 테스트 데이터:", testData);

    // Redis로 알림 발행
    await redisClient.publish("comment_events", JSON.stringify(testData));

    console.log("Redis publish 완료");

    res.json({
      success: true,
      message: "Redis 테스트 알림 전송됨",
      data: testData,
    });
  } catch (err) {
    console.error("Redis 테스트 알림 전송 오류:", err);
    res.status(500).json({ error: err.message });
  }
});

// 댓글 생성 시 호출할 엔드포인트 (실제 사용)
app.post("/api/comment/notify", express.json(), async (req, res) => {
  try {
    const commentData = req.body;
    console.log("실제 댓글 알림 발행:", commentData);

    await redisClient.publish("comment_events", JSON.stringify(commentData));

    res.json({ success: true, message: "댓글 알림 발행됨" });
  } catch (err) {
    console.error("댓글 알림 발행 오류:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SSE 서버 실행 중 on port ${PORT}`);
});
