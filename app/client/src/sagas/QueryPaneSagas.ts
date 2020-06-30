import _, { take } from "lodash";
import {
  all,
  select,
  put,
  takeEvery,
  call,
  takeLatest,
} from "redux-saga/effects";
import {
  ReduxAction,
  ReduxActionTypes,
  ReduxActionWithMeta,
  ReduxFormActionTypes,
  ReduxActionErrorTypes,
} from "constants/ReduxActionConstants";
import { getFormData } from "selectors/formSelectors";
import { QUERY_EDITOR_FORM_NAME } from "constants/forms";
import history from "utils/history";
import {
  QUERIES_EDITOR_URL,
  QUERIES_EDITOR_ID_URL,
  APPLICATIONS_URL,
} from "constants/routes";
import {
  getCurrentApplicationId,
  getCurrentPageId,
} from "selectors/editorSelectors";
import { change, initialize } from "redux-form";
import {
  extractBindingsFromAction,
  getAction,
  getActionParams,
  getActionTimeout,
} from "./ActionSagas";
import { AppState } from "reducers";
import ActionAPI, {
  PaginationField,
  ExecuteActionRequest,
  ActionApiResponse,
  Property,
} from "api/ActionAPI";
import { QUERY_CONSTANT } from "constants/QueryEditorConstants";
import { changeQuery, deleteQuerySuccess } from "actions/queryPaneActions";
import { AppToaster } from "components/editorComponents/ToastComponent";
import { ToastType } from "react-toastify";
import { PageAction } from "constants/ActionConstants";
import { isDynamicValue } from "utils/DynamicBindingUtils";
import AnalyticsUtil from "utils/AnalyticsUtil";
import { GenericApiResponse } from "api/ApiResponses";
import { validateResponse } from "./ErrorSagas";
import { getQueryName } from "selectors/entitiesSelector";
import { QueryAction, RestAction } from "entities/Action";
import { updateAction } from "actions/actionActions";

const getQueryDraft = (state: AppState, id: string) => {
  const drafts = state.entities.actionDrafts;
  if (id in drafts) return drafts[id];
  return {};
};

const getActions = (state: AppState) =>
  state.entities.actions.map(a => a.config);

const getLastUsedAction = (state: AppState) => state.ui.queryPane.lastUsed;

const getQueryCreationStatus = (state: AppState) =>
  state.ui.queryPane.isCreating;

function* initQueryPaneSaga(
  actionPayload: ReduxAction<{
    pluginType: string;
    id?: string;
  }>,
) {
  let actions = yield select(getActions);
  while (!actions.length) {
    yield take(ReduxActionTypes.FETCH_ACTIONS_SUCCESS);
    actions = yield select(getActions);
  }
  const urlId = actionPayload.payload.id;
  const lastUsedId = yield select(getLastUsedAction);
  const isCreating = yield select(getQueryCreationStatus);

  let id = "";
  if (urlId) {
    id = urlId;
  } else if (lastUsedId) {
    id = lastUsedId;
  }

  if (isCreating) return;

  yield put(changeQuery(id, QUERY_CONSTANT));
}

function* changeQuerySaga(
  actionPayload: ReduxAction<{ id: string; pluginType: string }>,
) {
  const { id } = actionPayload.payload;
  // Typescript says Element does not have blur function but it does;
  document.activeElement &&
    "blur" in document.activeElement &&
    // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
    // @ts-ignore
    document.activeElement.blur();

  const applicationId = yield select(getCurrentApplicationId);
  const pageId = yield select(getCurrentPageId);
  if (!applicationId || !pageId) {
    history.push(APPLICATIONS_URL);
    return;
  }
  const action = yield select(getAction, id);
  if (!action) {
    history.push(QUERIES_EDITOR_URL(applicationId, pageId));
    return;
  }

  const draft = yield select(getQueryDraft, id);
  const data = _.isEmpty(draft) ? action : draft;
  const URL = QUERIES_EDITOR_ID_URL(applicationId, pageId, id);
  yield put(initialize(QUERY_EDITOR_FORM_NAME, data));
  history.push(URL);
}

function* saveQueryAction() {
  const { values } = yield select(getFormData, QUERY_EDITOR_FORM_NAME);
  if (!values.id) return;
  const action = yield select(getAction, values.id);
  if (_.isEqual(values, action)) {
    yield put({
      type: ReduxActionTypes.DELETE_API_DRAFT,
      payload: { id: values.id },
    });
  } else {
    yield put({
      type: ReduxActionTypes.UPDATE_API_DRAFT,
      payload: { id: values.id, draft: values },
    });

    yield put(
      updateAction({
        data: values,
      }),
    );
  }
}

function* updateDynamicBindingsSaga(
  actionPayload: ReduxActionWithMeta<string, { field: string }>,
) {
  const field = actionPayload.meta.field;
  if (field === "dynamicBindingPathList") return;
  const value = actionPayload.payload;
  const { values } = yield select(getFormData, QUERY_EDITOR_FORM_NAME);
  if (!values.id) return;

  const isDynamic = isDynamicValue(value);
  let dynamicBindings: Property[] = values.dynamicBindingPathList || [];
  const fieldExists = _.some(dynamicBindings, { key: field });

  if (!isDynamic && fieldExists) {
    dynamicBindings = dynamicBindings.filter(d => d.key !== field);
  }
  if (isDynamic && !fieldExists) {
    dynamicBindings.push({ key: field });
  }
  yield put(
    change(QUERY_EDITOR_FORM_NAME, "dynamicBindingPathList", dynamicBindings),
  );
}

function* formValueChangeSaga(
  actionPayload: ReduxActionWithMeta<string, { field: string; form: string }>,
) {
  const { form } = actionPayload.meta;
  if (form !== QUERY_EDITOR_FORM_NAME) return;
  yield all([
    call(updateDynamicBindingsSaga, actionPayload),
    call(saveQueryAction),
  ]);
}

function* handleQueryCreatedSaga(actionPayload: ReduxAction<RestAction>) {
  const { id, pluginType } = actionPayload.payload;
  const action = yield select(getAction, id);
  const data = { ...action };
  if (pluginType === "DB") {
    yield put(initialize(QUERY_EDITOR_FORM_NAME, data));
    const applicationId = yield select(getCurrentApplicationId);
    const pageId = yield select(getCurrentPageId);
    history.replace(QUERIES_EDITOR_ID_URL(applicationId, pageId, id), {
      newQuery: true,
    });
  }
}

function* handleQueryDeletedSaga(actionPayload: ReduxAction<{ id: string }>) {
  const { id } = actionPayload.payload;
  const applicationId = yield select(getCurrentApplicationId);
  const pageId = yield select(getCurrentPageId);
  history.push(QUERIES_EDITOR_URL(applicationId, pageId));
  yield put({
    type: ReduxActionTypes.DELETE_API_DRAFT,
    payload: { id },
  });
}

function* handleMoveOrCopySaga(actionPayload: ReduxAction<{ id: string }>) {
  const { id } = actionPayload.payload;
  const action = yield select(getAction, id);
  const pluginType = action?.pluginType ?? "";

  if (pluginType === "DB") {
    const { values }: { values: RestAction } = yield select(
      getFormData,
      QUERY_EDITOR_FORM_NAME,
    );
    if (values.id === id) {
      yield put(initialize(QUERY_EDITOR_FORM_NAME, action));
    }
  }
}

export function* executeQuerySaga(
  actionPayload: ReduxAction<{
    action: QueryAction;
    actionId: string;
    paginationField: PaginationField;
  }>,
) {
  try {
    const {
      values,
      dirty,
    }: {
      values: QueryAction;
      dirty: boolean;
      valid: boolean;
    } = yield select(getFormData, QUERY_EDITOR_FORM_NAME);
    const actionObject: PageAction = yield select(getAction, values.id);
    let action: ExecuteActionRequest["action"] = { id: values.id };
    let jsonPathKeys = actionObject.jsonPathKeys;

    if (dirty) {
      action = _.omit(values, "id") as QueryAction;
      jsonPathKeys = extractBindingsFromAction(action as QueryAction);
    }

    const { paginationField } = actionPayload.payload;

    const params = yield call(getActionParams, jsonPathKeys);
    const timeout = yield select(getActionTimeout, values.id);
    const response: ActionApiResponse = yield ActionAPI.executeAction(
      {
        action,
        params,
        paginationField,
      },
      timeout,
    );
    const isValidResponse = yield validateResponse(response);
    const isExecutionSuccess = response.data.isExecutionSuccess;

    if (!isExecutionSuccess) {
      throw Error(response.data.body.toString());
    }

    if (isValidResponse) {
      yield put({
        type: ReduxActionTypes.RUN_QUERY_SUCCESS,
        payload: {
          data: response.data,
          actionId: actionPayload.payload.actionId,
        },
      });
      AppToaster.show({
        message: "Query ran successfully",
        type: ToastType.SUCCESS,
      });
      AnalyticsUtil.logEvent("RUN_QUERY", {
        queryName: actionPayload.payload.action.name,
      });
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.RUN_QUERY_ERROR,
      payload: {
        actionId: actionPayload.payload.actionId,
        message: error.message,
        show: false,
      },
    });

    AppToaster.show({
      message: error.message,
      type: ToastType.ERROR,
    });
  }
}

export function* deleteQuerySaga(actionPayload: ReduxAction<{ id: string }>) {
  try {
    const id = actionPayload.payload.id;
    const response: GenericApiResponse<RestAction> = yield ActionAPI.deleteAction(
      id,
    );
    const isValidResponse = yield validateResponse(response);
    if (isValidResponse) {
      const queryName = yield select(getQueryName, id);
      AnalyticsUtil.logEvent("DELETE_QUERY", {
        queryName,
      });
      AppToaster.show({
        message: `${response.data.name} Action deleted`,
        type: ToastType.SUCCESS,
      });
      yield put(deleteQuerySuccess({ id }));
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.DELETE_QUERY_ERROR,
      payload: { error, id: actionPayload.payload.id },
    });
  }
}

export default function* root() {
  yield all([
    takeEvery(ReduxActionTypes.CREATE_ACTION_SUCCESS, handleQueryCreatedSaga),
    takeLatest(ReduxActionTypes.DELETE_QUERY_INIT, deleteQuerySaga),
    takeEvery(ReduxActionTypes.DELETE_QUERY_SUCCESS, handleQueryDeletedSaga),
    takeEvery(ReduxActionTypes.MOVE_ACTION_SUCCESS, handleMoveOrCopySaga),
    takeEvery(ReduxActionTypes.COPY_ACTION_SUCCESS, handleMoveOrCopySaga),
    takeLatest(ReduxActionTypes.EXECUTE_QUERY_REQUEST, executeQuerySaga),
    takeEvery(ReduxActionTypes.QUERY_PANE_CHANGE, changeQuerySaga),
    takeEvery(ReduxActionTypes.INIT_QUERY_PANE, initQueryPaneSaga),
    // Intercepting the redux-form change actionType
    takeEvery(ReduxFormActionTypes.VALUE_CHANGE, formValueChangeSaga),
    takeEvery(ReduxFormActionTypes.ARRAY_REMOVE, formValueChangeSaga),
  ]);
}