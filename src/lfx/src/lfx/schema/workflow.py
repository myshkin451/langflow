"""Workflow execution schemas for V2 API."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from lfx.schema.validators import null_check_validator, uuid_validator


class JobStatus(str, Enum):
    """Job execution status."""

    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"


JobId = Annotated[
    str | UUID,
    BeforeValidator(lambda v: null_check_validator(v, message="job_id is required")),
    BeforeValidator(lambda v: uuid_validator(v, message="Invalid job_id, must be a UUID")),
]


class ErrorDetail(BaseModel):
    """Error detail schema."""

    error: str
    code: str | None = None
    details: dict[str, Any] | None = None


class ComponentOutput(BaseModel):
    """Component output schema."""

    type: str = Field(..., description="Type of the component output (e.g., 'message', 'data', 'tool', 'text')")
    status: JobStatus
    content: Any | None = None
    metadata: dict[str, Any] | None = None


class WorkflowExecutionRequest(BaseModel):
    """Request schema for workflow execution."""

    background: bool = False
    stream: bool = False
    flow_id: str
    inputs: dict[str, Any] | None = Field(
        None, description="Component-specific inputs in flat format: 'component_id.param_name': value"
    )

    @model_validator(mode="after")
    def validate_execution_mode(self) -> WorkflowExecutionRequest:
        if self.background and self.stream:
            err_msg = "Both 'background' and 'stream' cannot be True"
            raise ValueError(err_msg)
        return self

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "background": False,
                    "stream": False,
                    "flow_id": "flow_67ccd2be17f0819081ff3bb2cf6508e60bb6a6b452d3795b",
                    "inputs": {
                        "ChatInput-abc.input_value": "Hello, how can you help me today?",
                        "ChatInput-abc.session_id": "session-123",
                        "LLM-xyz.temperature": 0.7,
                        "LLM-xyz.max_tokens": 100,
                        "OpenSearch-def.opensearch_url": "https://opensearch:9200",
                    },
                },
                {
                    "background": True,
                    "stream": False,
                    "flow_id": "flow_67ccd2be17f0819081ff3bb2cf6508e60bb6a6b452d3795b",
                    "inputs": {
                        "ChatInput-abc.input_value": "Process this in the background",
                    },
                },
                {
                    "background": False,
                    "stream": True,
                    "flow_id": "flow_67ccd2be17f0819081ff3bb2cf6508e60bb6a6b452d3795b",
                    "inputs": {
                        "ChatInput-abc.input_value": "Stream this conversation",
                    },
                },
            ]
        },
        extra="forbid",
    )


class WorkflowMode(str, Enum):
    """Execution mode for a v2 workflow run."""

    SYNC = "sync"
    STREAM = "stream"
    BACKGROUND = "background"


class WorkflowRunRequest(BaseModel):
    """Request schema for ``POST /api/v2/workflows`` (v2 native body).

    First-class fields for everything callers actually configure when running a
    flow. Streaming protocol is selected by ``stream_protocol``; the endpoint
    validates it against the live adapter registry and returns 422 with the
    available list when unknown.
    """

    flow_id: str = Field(..., description="UUID of the flow to run.")
    input_value: str = Field("", description="Chat-style input value.")
    tweaks: dict[str, Any] = Field(
        default_factory=dict,
        description="Per-component parameter overrides keyed by component id.",
    )
    session_id: str | None = Field(
        None,
        description="When set, message memory and chat history scope to this session.",
    )
    mode: WorkflowMode = Field(
        WorkflowMode.SYNC,
        description=(
            "Execution mode. ``sync`` runs inline and returns the aggregated "
            "response; ``stream`` returns SSE; ``background`` queues a job."
        ),
    )
    stream_protocol: str = Field(
        "langflow",
        description=(
            "Wire protocol for streaming events. Defaults to ``langflow`` "
            "(raw EventManager payloads). ``agui`` emits AG-UI events. Unknown "
            "values return 422 with the available list. Ignored when mode=sync."
        ),
    )
    data: dict[str, Any] | None = Field(
        None,
        description=(
            "Optional live-canvas override of the flow's nodes/edges; takes priority over the saved flow data."
        ),
    )
    files: list[str] | None = Field(
        None,
        description="Optional list of pre-uploaded file paths to attach to the run.",
    )
    start_component_id: str | None = Field(None, description="Partial-run start component id.")
    stop_component_id: str | None = Field(None, description="Partial-run stop component id.")

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "flow_id": "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
                    "input_value": "Hello, how can you help me today?",
                },
                {
                    "flow_id": "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
                    "input_value": "Stream this conversation",
                    "mode": "stream",
                },
                {
                    "flow_id": "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
                    "input_value": "Drive the canvas",
                    "mode": "stream",
                    "stream_protocol": "agui",
                    "session_id": "session-123",
                },
                {
                    "flow_id": "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
                    "input_value": "Process in the background",
                    "mode": "background",
                },
            ],
        },
    )

    @model_validator(mode="after")
    def validate_flow_id(self) -> WorkflowRunRequest:
        """Reject non-UUID ``flow_id`` early so the endpoint can trust it."""
        uuid_validator(self.flow_id, message="Invalid flow_id, must be a UUID")
        return self


class WorkflowExecutionResponse(BaseModel):
    """Synchronous workflow execution response."""

    flow_id: str
    job_id: JobId | None = None
    object: Literal["response"] = Field(default="response")
    created_timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    status: JobStatus
    errors: list[ErrorDetail] = []
    inputs: dict[str, Any] = {}
    outputs: dict[str, ComponentOutput] = {}


class WorkflowJobResponse(BaseModel):
    """Background job response."""

    job_id: JobId
    flow_id: str
    object: Literal["job"] = Field(default="job")
    created_timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    status: JobStatus
    links: dict[str, str] = Field(default_factory=dict)
    errors: list[ErrorDetail] = []

    @model_validator(mode="after")
    def build_links(self) -> WorkflowJobResponse:
        """Automatically populate links for the client."""
        if not self.links:
            self.links = {
                "status": f"/api/v2/workflows?job_id={self.job_id!s}",
                "stop": "/api/v2/workflows/stop",
            }
        return self


class WorkflowStreamEvent(BaseModel):
    """Streaming event response."""

    type: str
    run_id: str
    timestamp: int
    raw_event: dict[str, Any]


class WorkflowStopRequest(BaseModel):
    """Request schema for stopping workflow."""

    job_id: JobId


class WorkflowStopResponse(BaseModel):
    """Response schema for stopping workflow."""

    job_id: JobId
    message: str | None = None


# OpenAPI response definitions
WORKFLOW_EXECUTION_RESPONSES = {
    200: {
        "description": "Workflow execution response",
        "content": {
            "application/json": {
                "schema": {
                    "oneOf": [
                        WorkflowExecutionResponse.model_json_schema(),
                        WorkflowJobResponse.model_json_schema(),
                    ],
                    "discriminator": {
                        "propertyName": "object",
                        "mapping": {
                            "response": "#/components/schemas/WorkflowExecutionResponse",
                            "job": "#/components/schemas/WorkflowJobResponse",
                        },
                    },
                }
            },
            "text/event-stream": {
                "schema": WorkflowStreamEvent.model_json_schema(),
                "description": "Server-sent events for streaming execution",
            },
        },
    }
}

WORKFLOW_STATUS_RESPONSES = {
    200: {
        "description": "Workflow status response",
        "content": {
            "application/json": {"schema": WorkflowExecutionResponse.model_json_schema()},
            "text/event-stream": {
                "schema": WorkflowStreamEvent.model_json_schema(),
                "description": "Server-sent events for streaming status",
            },
        },
    }
}
