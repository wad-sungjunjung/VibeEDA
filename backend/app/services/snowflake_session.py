"""Snowflake 연결 세션 싱글톤 관리"""
import threading
from typing import Optional

_connection = None
_conn_params: dict = {}
_lock = threading.Lock()


def is_connected() -> bool:
    global _connection
    with _lock:
        if _connection is None:
            return False
        try:
            cur = _connection.cursor()
            cur.execute("SELECT 1", timeout=3)
            return True
        except Exception:
            _connection = None
            return False


def connect(params: dict) -> None:
    global _connection, _conn_params
    import snowflake.connector

    with _lock:
        if _connection:
            try:
                _connection.close()
            except Exception:
                pass
            _connection = None

        _connection = snowflake.connector.connect(
            account=params["account"],
            user=params["user"],
            authenticator=params.get("authenticator", "externalbrowser"),
            role=params.get("role") or None,
            warehouse=params.get("warehouse") or None,
            database=params.get("database") or None,
            schema=params.get("schema") or None,
            login_timeout=params.get("login_timeout", 120),
            # externalbrowser SSO 토큰을 로컬 디스크에 캐시. 페이지 새로고침 후
            # 자동 재접속 시 브라우저 팝업 없이 조용히 연결되도록 한다.
            client_store_temporary_credential=True,
            client_request_mfa_token=True,
        )
        _conn_params = params.copy()


def get_connection():
    global _connection
    with _lock:
        if _connection is None:
            raise ValueError(
                "Snowflake에 연결되지 않았습니다.\n"
                "왼쪽 사이드바 '연결 관리'에서 연결해주세요."
            )
        return _connection


def disconnect() -> None:
    global _connection, _conn_params
    with _lock:
        if _connection:
            try:
                _connection.close()
            except Exception:
                pass
            _connection = None
        _conn_params = {}


def get_status() -> dict:
    global _conn_params
    connected = is_connected()
    return {
        "connected": connected,
        "account": _conn_params.get("account", ""),
        "user": _conn_params.get("user", ""),
        "database": _conn_params.get("database", ""),
        "schema": _conn_params.get("schema", ""),
        "warehouse": _conn_params.get("warehouse", ""),
    }
