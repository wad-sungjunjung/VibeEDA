"""Snowflake 연결 세션 싱글톤 관리"""
import threading
from typing import Optional

_connection = None
_conn_params: dict = {}
_lock = threading.Lock()


def is_connected() -> bool:
    global _connection
    # 락을 최소한만 잡아 참조만 복사. SELECT 1 ping은 락 밖에서 실행해
    # 네트워크 hang 시 다른 스레드가 블록되는 데드락을 방지한다.
    with _lock:
        conn = _connection
    if conn is None:
        return False
    cur = None
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1", timeout=3)
        return True
    except Exception:
        # ping 실패 → 죽은 커넥션 제거. 다른 스레드가 그 사이 새로 connect()
        # 했으면 _connection 참조가 바뀌어 있으므로 'is conn' 체크로 보호.
        with _lock:
            if _connection is conn:
                _connection = None
        return False
    finally:
        if cur is not None:
            try:
                cur.close()
            except Exception:
                pass


def get_connection():
    global _connection
    with _lock:
        if _connection is None:
            raise ValueError(
                "Snowflake에 연결되지 않았습니다.\n"
                "왼쪽 사이드바 '연결 관리'에서 연결해주세요."
            )
        return _connection


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
            # fetch_pandas_all()이 동작하려면 세션 결과 포맷이 ARROW여야 함.
            # 일부 계정/웨어하우스가 JSON을 기본값으로 갖는 경우 방어.
            session_parameters={"PYTHON_CONNECTOR_QUERY_RESULT_FORMAT": "ARROW"},
        )
        _conn_params = params.copy()


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


def try_silent_reconnect(login_timeout: int = 15) -> bool:
    """저장된 파라미터로 조용히 재접속 시도.

    externalbrowser SSO 의 캐시된 MFA 토큰(client_store_temporary_credential)
    이 살아있으면 브라우저 팝업 없이 즉시 재접속된다. 캐시가 만료되어 팝업이
    필요한 경우 login_timeout 이 차서 False 를 반환한다.

    Returns:
        True  — 재접속 성공
        False — 저장된 파라미터 없거나 재접속 실패
    """
    global _connection, _conn_params
    with _lock:
        params = _conn_params.copy() if _conn_params else None
    if not params:
        return False

    # 짧은 login_timeout 으로 시도 — 브라우저 팝업이 떠야 하는 경우 빠르게 포기.
    retry_params = params.copy()
    retry_params["login_timeout"] = login_timeout
    try:
        connect(retry_params)
        # 원래 login_timeout 값 보존 (다음 명시적 connect 호출까지)
        with _lock:
            _conn_params = params
        return True
    except Exception:
        return False


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
