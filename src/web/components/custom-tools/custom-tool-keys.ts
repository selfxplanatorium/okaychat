import type { PlainMessageKey } from "@/i18n";
import type { RunErrorCode, RunState, ValidationReason } from "@shared/custom-tools";

// Literal key tables: the i18n test finds every key and typecheck proves every code has text.
export const RUN_STATE_KEY: Record<RunState, PlainMessageKey> = {
  prepared: "customTools.statePrepared",
  running: "customTools.stateRunning",
  succeeded: "customTools.stateSucceeded",
  failed: "customTools.stateFailed",
  cancelled: "customTools.stateCancelled",
  unknown: "customTools.stateUnknown",
  denied: "customTools.stateDenied",
  expired: "customTools.stateExpired",
};

export const RUN_ERROR_KEY: Record<RunErrorCode, PlainMessageKey> = {
  invalid_input: "customTools.errorInvalidInput",
  definition_changed: "customTools.errorDefinitionChanged",
  disabled: "customTools.errorDisabled",
  permission_denied: "customTools.errorPermissionDenied",
  approval_required: "customTools.errorApprovalRequired",
  approval_expired: "customTools.errorApprovalExpired",
  approval_denied: "customTools.errorApprovalDenied",
  blocked_destination: "customTools.errorBlockedDestination",
  redirect_blocked: "customTools.errorRedirectBlocked",
  rate_limited: "customTools.errorRateLimited",
  service_unavailable: "customTools.errorServiceUnavailable",
  timeout: "customTools.errorTimeout",
  cancelled: "customTools.errorCancelled",
  response_too_large: "customTools.errorResponseTooLarge",
  invalid_json: "customTools.errorInvalidJson",
  invalid_result: "customTools.errorInvalidResult",
  python_error: "customTools.errorPythonError",
  http_status: "customTools.errorHttpStatus",
  network_error: "customTools.errorNetworkError",
  outcome_unknown: "customTools.errorOutcomeUnknown",
};

export const VALIDATION_KEY: Record<ValidationReason, PlainMessageKey> = {
  invalid_json: "customTools.validationInvalidJson",
  duplicate_key: "customTools.validationDuplicateKey",
  reserved_key: "customTools.validationReservedKey",
  unsupported_keyword: "customTools.validationUnsupportedKeyword",
  wrong_type: "customTools.validationWrongType",
  required: "customTools.validationRequired",
  unknown_property: "customTools.validationUnknownProperty",
  too_large: "customTools.validationTooLarge",
  too_deep: "customTools.validationTooDeep",
  too_many_nodes: "customTools.validationTooManyNodes",
  out_of_range: "customTools.validationOutOfRange",
  invalid_reference: "customTools.validationInvalidReference",
  invalid_destination: "customTools.validationInvalidDestination",
  invalid_header: "customTools.validationInvalidHeader",
  invalid_schema: "customTools.validationInvalidSchema",
};
