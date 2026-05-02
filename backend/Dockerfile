# ── Stage 1: builder ──────────────────────────────────────────────────────────
# 휠 빌드/네트워크 호출은 builder 에서만 수행. 결과는 site-packages 만 복사한다.
# `INSTALL_MODE` 빌드 인자로 코어/풀 선택:
#   --build-arg INSTALL_MODE=core   기본 — kaleido/ML/Arrow 제외 (~280MB)
#   --build-arg INSTALL_MODE=full   기존 동등 (~700MB)
FROM python:3.12-slim AS builder

ARG INSTALL_MODE=core

WORKDIR /build

COPY requirements.txt requirements-vis.txt requirements-ml.txt requirements-arrow.txt ./

RUN python -m pip install --upgrade pip wheel \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt \
    && if [ "$INSTALL_MODE" = "full" ]; then \
         pip install --no-cache-dir --prefix=/install -r requirements-vis.txt -r requirements-ml.txt -r requirements-arrow.txt ; \
       fi


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
# 빌드 도구·캐시 없이 런타임 라이브러리만 복사.
FROM python:3.12-slim AS runtime

WORKDIR /app

# 빌더의 site-packages + 콘솔 스크립트 복사
COPY --from=builder /install /usr/local

# 앱 코드
COPY . .

# 빌드 캐시 정리(이미지 사이즈 추가 회수)
RUN find /usr/local -name '__pycache__' -type d -prune -exec rm -rf '{}' + \
    && rm -rf /root/.cache /tmp/*

ENV PORT=8000 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
