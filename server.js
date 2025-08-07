require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const redis = require("redis");

const app = express();
const PORT = process.env.PORT || 4000;

const localSSEClients = [];

// 환경에 따른 CORS 설정
const corsOrigin =
  process.env.NODE_ENV === "production"
    ? ["https://www.tokti.net", "https://tokti.net"]
    : ["https://www.tokti.net", "https://tokti.net", "http://localhost:3000"];

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
let redisClient, redisSubscriber;
const useRedis =
  process.env.REDIS_URL &&
  process.env.REDIS_URL !== "redis://localhost:6379" &&
  process.env.NODE_ENV === "production";

if (useRedis) {
  redisClient = redis.createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redisSubscriber = redis.createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });
} else {
  // Redis 비활성화
} // Redis 연결
(async () => {
  if (useRedis) {
    try {
      await redisClient.connect();
      await redisSubscriber.connect();
      // Redis 연결 성공
    } catch (err) {
      // Redis 연결 실패
    }
  }
})();

const clients = {};

// SSE 연결 공통 세팅 함수
function setupSSE(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // CORS 헤더 추가
  res.setHeader("Access-Control-Allow-Origin", "*");
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
    // Postgres client error handling
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
    // Response error handling
  });
});

// comments 스트림 - Redis pub/sub 방식
app.get("/comments/stream", async (req, res) => {
  const disconnect = setupSSE(req, res);

  // 즉시 연결 확인 메시지 전송
  res.write(
    `data: ${JSON.stringify({
      event: "connected",
      message: useRedis
        ? "SSE 연결 성공 (Redis 모드)"
        : "SSE 연결 성공 (로컬 모드)",
    })}\n\n`
  );

  if (!useRedis) {
    // 로컬 모드 - Redis 없이 SSE 연결 시작

    localSSEClients.push(res);
    // 현재 연결된 로컬 클라이언트 수 추가됨

    req.on("close", () => {
      const idx = localSSEClients.indexOf(res);
      if (idx !== -1) {
        localSSEClients.splice(idx, 1);
        // 클라이언트 연결 해제됨
      }
      disconnect();
    });

    res.on("error", (err) => {
      // 로컬 SSE 응답 오류
      const idx = localSSEClients.indexOf(res);
      if (idx !== -1) {
        localSSEClients.splice(idx, 1);
      }
      disconnect();
    });

    return;
  }

  let isActive = true;

  // Redis 메시지 리스너
  const messageHandler = (message) => {
    if (!isActive) return;

    try {
      const data = JSON.parse(message);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // Redis 메시지 파싱 오류
    }
  };

  // Redis 구독 시작
  try {
    await redisSubscriber.subscribe("comment_events", messageHandler);
  } catch (err) {
    // Redis 구독 오류
    res.write(
      `data: ${JSON.stringify({
        event: "error",
        message: "Redis 구독 오류",
      })}\n\n`
    );
  }

  req.on("close", async () => {
    isActive = false;
    try {
      await redisSubscriber.unsubscribe("comment_events");
    } catch (err) {
      // Redis 구독 해제 오류
    }
    disconnect();
  });

  res.on("error", async (err) => {
    // Response error (Redis)
    isActive = false;
    try {
      await redisSubscriber.unsubscribe("comment_events");
    } catch (unsubErr) {
      // Redis 구독 해제 오류
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
    // Postgres client error handling
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
    // Response error handling
  });
});

// 테스트용 엔드포인트 - Redis로 알림 전송
app.get("/test/notify", async (req, res) => {
  try {
    const postId = 1; // 기본값

    const testData = {
      id: 999,
      event: "INSERT",
      post_id: postId,
      user_id: 1,
      user_nickname: "테스트유저",
      content: "테스트 댓글",
      parent_id: null,
      profile: "/profile/basic.png",
      likes: 0,
      depth: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (useRedis) {
      // Redis로 알림 발행
      await redisClient.publish("comment_events", JSON.stringify(testData));
      res.json({
        success: true,
        message: "Redis 테스트 알림 전송됨",
        data: testData,
      });
    } else {
      // 로컬 모드에서는 직접 연결된 클라이언트들에게 전송
      const dataString = `data: ${JSON.stringify(testData)}\n\n`;
      localSSEClients.forEach((clientRes) => {
        try {
          clientRes.write(dataString);
        } catch (err) {
          console.error("로컬 SSE 전송 오류:", err);
        }
      });

      res.json({
        success: true,
        message: `로컬 모드 - 테스트 알림 전송됨 (${localSSEClients.length}개 클라이언트에게 전송)`,
        data: testData,
      });
    }
  } catch (err) {
    console.error("테스트 알림 전송 오류:", err);
    res.status(500).json({ error: err.message });
  }
});

// 테스트용 엔드포인트 - postId 지정
app.get("/test/notify/:postId", async (req, res) => {
  try {
    const postId = req.params.postId ? parseInt(req.params.postId) : 1;
    // 테스트 알림 요청

    const testData = {
      id: 999,
      event: "INSERT",
      post_id: postId,
      user_id: 1,
      user_nickname: "테스트유저",
      content: "테스트 댓글",
      parent_id: null,
      profile: "/profile/basic.png",
      likes: 0,
      depth: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (useRedis) {
      // Redis로 알림 발행
      await redisClient.publish("comment_events", JSON.stringify(testData));
      res.json({
        success: true,
        message: "Redis 테스트 알림 전송됨",
        data: testData,
      });
    } else {
      // 로컬 모드에서는 직접 연결된 클라이언트들에게 전송
      const dataString = `data: ${JSON.stringify(testData)}\n\n`;
      localSSEClients.forEach((clientRes) => {
        try {
          clientRes.write(dataString);
        } catch (err) {
          console.error("로컬 SSE 전송 오류:", err);
        }
      });

      res.json({
        success: true,
        message: `로컬 모드 - 테스트 알림 전송됨 (${localSSEClients.length}개 클라이언트에게 전송)`,
        data: testData,
      });
    }
  } catch (err) {
    console.error("테스트 알림 전송 오류:", err);
    res.status(500).json({ error: err.message });
  }
});

// 댓글 생성 시 호출할 엔드포인트 (실제 사용)
app.post("/api/comment/notify", express.json(), async (req, res) => {
  try {
    const commentData = req.body;
    if (useRedis) {
      await redisClient.publish("comment_events", JSON.stringify(commentData));
      res.json({ success: true, message: "댓글 알림 발행됨" });
    } else {
      // 로컬 모드에서는 직접 연결된 클라이언트들에게 전송
      const dataString = `data: ${JSON.stringify(commentData)}\n\n`;

      localSSEClients.forEach((clientRes, index) => {
        try {
          clientRes.write(dataString);
        } catch (err) {
          console.error(`❌ 클라이언트 ${index + 1} 전송 오류:`, err);
        }
      });

      res.json({
        success: true,
        message: `로컬 모드 - 댓글 알림 처리됨 (${localSSEClients.length}개 클라이언트에게 전송)`,
      });
    }
  } catch (err) {
    console.error("댓글 알림 발행 오류:", err);
    res.status(500).json({ error: err.message });
  }
});

// 댓글 좋아요 변경 시 호출할 엔드포인트
app.post("/api/comment/like-notify", express.json(), async (req, res) => {
  try {
    const likeData = req.body;
    if (useRedis) {
      await redisClient.publish("comment_events", JSON.stringify(likeData));
      res.json({ success: true, message: "좋아요 변경 알림 발행됨" });
    } else {
      // 로컬 모드에서는 직접 연결된 클라이언트들에게 전송
      const dataString = `data: ${JSON.stringify(likeData)}\n\n`;
      localSSEClients.forEach((clientRes) => {
        try {
          clientRes.write(dataString);
        } catch (err) {
          console.error("로컬 SSE 전송 오류:", err);
        }
      });

      res.json({
        success: true,
        message: `로컬 모드 - 좋아요 알림 처리됨 (${localSSEClients.length}개 클라이언트에게 전송)`,
      });
    }
  } catch (err) {
    console.error("좋아요 변경 알림 발행 오류:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SSE 서버 실행 중 on port ${PORT}`);
});
