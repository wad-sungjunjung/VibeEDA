from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    default_agent_model: str = Field(default="claude-opus-4-7", alias="DEFAULT_AGENT_MODEL")
    default_vibe_model: str = Field(default="gemini-2.5-flash", alias="DEFAULT_VIBE_MODEL")

    allowed_origins: list[str] = Field(
        default=["http://localhost:5173", "http://localhost:4173"],
        alias="ALLOWED_ORIGINS",
    )

    # Snowflake (optional — SQL 실행 시만 필요)
    snowflake_account: str = Field(default="", alias="SNOWFLAKE_ACCOUNT")
    snowflake_user: str = Field(default="", alias="SNOWFLAKE_USER")
    snowflake_password: str = Field(default="", alias="SNOWFLAKE_PASSWORD")
    snowflake_database: str = Field(default="", alias="SNOWFLAKE_DATABASE")
    snowflake_warehouse: str = Field(default="", alias="SNOWFLAKE_WAREHOUSE")
    snowflake_schema: str = Field(default="PUBLIC", alias="SNOWFLAKE_SCHEMA")


settings = Settings()


class LLMConfig:
    def __init__(self, anthropic_api_key: str, vibe_model: str, agent_model: str):
        self.anthropic_api_key = anthropic_api_key
        self.vibe_model = vibe_model
        self.agent_model = agent_model


def get_llm_config(
    x_anthropic_key: str = "",
    x_vibe_model: str = "",
    x_agent_model: str = "",
) -> LLMConfig:
    return LLMConfig(
        anthropic_api_key=x_anthropic_key or settings.anthropic_api_key,
        vibe_model=x_vibe_model or settings.default_vibe_model,
        agent_model=x_agent_model or settings.default_agent_model,
    )
