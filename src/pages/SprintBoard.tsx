import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type ColumnId = string;

type Column = {
  id: ColumnId;
  title: string;
  order: number;
};

type Card = {
  id: string;
  columnId: ColumnId;
  rank: number;
  title: string;
  description: string;
  points: number;
  createdAt?: number;
  updatedAt?: number;
};

type BoardState = {
  boardId: string;
  name: string;
  version: number;
  columns: Column[];
  cardsById: Record<string, Card>;
  columnCardIds: Record<ColumnId, string[]>;
};

type ModalMode =
  | { open: false }
  | { open: true; mode: "create_card"; columnId: ColumnId }
  | { open: true; mode: "edit_card"; cardId: string }
  | { open: true; mode: "create_column" }
  | { open: true; mode: "rename_column"; columnId: ColumnId };

const STORAGE_BOARD_ID = "sb_board_id";
const DEFAULT_API_BASE = "https://73b479c528ee.ngrok-free.app";

function getApiBase() {
  // ปรับได้: (window as any).__API_BASE__ = "https://your-api"
  return (window as any).__API_BASE__ || DEFAULT_API_BASE;
}

function isColumnId(id: string, columns: Column[]) {
  return columns.some((c) => c.id === id);
}

function findContainerOf(
  id: string,
  columnCardIds: Record<ColumnId, string[]>,
  columns: Column[]
): ColumnId | null {
  if (isColumnId(id, columns)) return id;
  for (const colId of Object.keys(columnCardIds)) {
    if ((columnCardIds[colId] || []).includes(id)) return colId;
  }
  return null;
}

function insertAt<T>(arr: T[], index: number, item: T) {
  const next = arr.slice();
  const i = Math.max(0, Math.min(index, next.length));
  next.splice(i, 0, item);
  return next;
}

function removeFrom<T>(arr: T[], item: T) {
  const idx = arr.indexOf(item);
  if (idx === -1) return arr.slice();
  const next = arr.slice();
  next.splice(idx, 1);
  return next;
}

async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: any;
    accountId: string;
  }
): Promise<T> {
  const base = getApiBase();
  const res = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      "x-account-id": options.accountId,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export default function SprintBoardApi() {
  const [accountId, setAccountId] = useState<string>(() => {
    return localStorage.getItem("sb_account_id") || "demo-account";
  });

  useEffect(() => {
    localStorage.setItem("sb_account_id", accountId);
  }, [accountId]);

  const [board, setBoard] = useState<BoardState | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalMode>({ open: false });

  // drag snapshot เพื่อรู้ว่าต้อง sync หรือไม่
  const dragStartRef = useRef<{
    cardId: string;
    fromColId: string;
    fromIndex: number;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const activeCardIdRef = useRef<string | null>(null);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);

  const activeCard = useMemo(() => {
    if (!board || !activeCardId) return null;
    return board.cardsById[activeCardId] || null;
  }, [board, activeCardId]);

  async function refresh(boardId: string) {
    setLoading(true);
    setErrMsg(null);
    try {
      const r = await apiFetch<{ ok: true; state: BoardState }>(
        `/boards/${boardId}`,
        {
          accountId,
        }
      );
      setBoard(r.state);
      localStorage.setItem(STORAGE_BOARD_ID, boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Failed to load board");
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }

  async function ensureBoard() {
    setLoading(true);
    setErrMsg(null);
    try {
      let boardId = localStorage.getItem(STORAGE_BOARD_ID);

      if (boardId) {
        // try load
        try {
          const r = await apiFetch<{ ok: true; state: BoardState }>(
            `/boards/${boardId}`,
            {
              accountId,
            }
          );
          setBoard(r.state);
          setLoading(false);
          return;
        } catch {
          // if not found -> create new
          boardId = null;
        }
      }

      const created = await apiFetch<{ ok: true; boardId: string }>(`/boards`, {
        method: "POST",
        body: {
          name: "Sprint Board",
          columns: ["To Do", "In Progress", "Done"],
        },
        accountId,
      });
      await refresh(created.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Failed to init board");
      setBoard(null);
      setLoading(false);
    }
  }

  useEffect(() => {
    ensureBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // ---------- Mutations ----------
  async function addColumn(title: string) {
    if (!board) return;
    setErrMsg(null);
    try {
      await apiFetch(`/boards/${board.boardId}/columns`, {
        method: "POST",
        body: { title },
        accountId,
      });
      await refresh(board.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Add column failed");
    }
  }

  async function renameColumn(columnId: string, title: string) {
    if (!board) return;
    setErrMsg(null);

    // optimistic
    setBoard((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        columns: prev.columns.map((c) =>
          c.id === columnId ? { ...c, title } : c
        ),
      };
    });

    try {
      await apiFetch(`/boards/${board.boardId}/columns/${columnId}`, {
        method: "PATCH",
        body: { title },
        accountId,
      });
      await refresh(board.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Rename column failed");
      await refresh(board.boardId);
    }
  }

  async function deleteColumn(
    columnId: string,
    mode: "move_cards" | "delete_cards"
  ) {
    if (!board) return;
    setErrMsg(null);
    try {
      await apiFetch(
        `/boards/${board.boardId}/columns/${columnId}?mode=${mode}`,
        {
          method: "DELETE",
          accountId,
        }
      );
      await refresh(board.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Delete column failed");
    }
  }

  async function createCard(
    columnId: string,
    data: Omit<Card, "id" | "columnId" | "rank">
  ) {
    if (!board) return;
    setErrMsg(null);
    try {
      await apiFetch(`/boards/${board.boardId}/cards`, {
        method: "POST",
        body: { columnId, ...data },
        accountId,
      });
      await refresh(board.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Create card failed");
    }
  }

  async function updateCard(
    cardId: string,
    patch: Partial<Pick<Card, "title" | "description" | "points">>
  ) {
    if (!board) return;
    setErrMsg(null);

    // optimistic
    setBoard((prev) => {
      if (!prev) return prev;
      const cur = prev.cardsById[cardId];
      if (!cur) return prev;
      return {
        ...prev,
        cardsById: {
          ...prev.cardsById,
          [cardId]: { ...cur, ...patch },
        },
      };
    });

    try {
      await apiFetch(`/boards/${board.boardId}/cards/${cardId}`, {
        method: "PATCH",
        body: patch,
        accountId,
      });
      await refresh(board.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Update card failed");
      await refresh(board.boardId);
    }
  }

  async function deleteCard(cardId: string) {
    if (!board) return;
    setErrMsg(null);

    // optimistic remove
    setBoard((prev) => {
      if (!prev) return prev;
      const nextCards = { ...prev.cardsById };
      delete nextCards[cardId];
      const nextMap: Record<string, string[]> = { ...prev.columnCardIds };
      for (const colId of Object.keys(nextMap)) {
        nextMap[colId] = (nextMap[colId] || []).filter((id) => id !== cardId);
      }
      return { ...prev, cardsById: nextCards, columnCardIds: nextMap };
    });

    try {
      await apiFetch(`/boards/${board.boardId}/cards/${cardId}`, {
        method: "DELETE",
        accountId,
      });
      await refresh(board.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Delete card failed");
      await refresh(board.boardId);
    }
  }

  async function syncMoveCard(cardId: string) {
    if (!board) return;

    const toColId = findContainerOf(cardId, board.columnCardIds, board.columns);
    if (!toColId) return;

    const list = board.columnCardIds[toColId] || [];
    const idx = list.indexOf(cardId);
    if (idx === -1) return;

    const beforeCardId = idx > 0 ? list[idx - 1] : null;
    const afterCardId = idx < list.length - 1 ? list[idx + 1] : null;

    try {
      await apiFetch(`/boards/${board.boardId}/cards/${cardId}/move`, {
        method: "POST",
        body: {
          toColumnId: toColId,
          beforeCardId,
          afterCardId,
        },
        accountId,
      });
      await refresh(board.boardId);
    } catch (e: any) {
      setErrMsg(e?.message || "Move sync failed");
      await refresh(board.boardId);
    }
  }

  // ---------- DnD handlers (optimistic + sync) ----------
  function handleDragStart(e: any) {
    if (!board) return;
    const id = String(e.active.id);
    if (isColumnId(id, board.columns)) return;

    activeCardIdRef.current = id;
    setActiveCardId(id);

    const fromCol = findContainerOf(id, board.columnCardIds, board.columns);
    if (!fromCol) return;

    const fromIndex = (board.columnCardIds[fromCol] || []).indexOf(id);
    dragStartRef.current = { cardId: id, fromColId: fromCol, fromIndex };
  }

  function handleDragOver(e: any) {
    if (!board) return;

    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    if (isColumnId(activeId, board.columns)) return;

    setBoard((prev) => {
      if (!prev) return prev;

      const activeCol = findContainerOf(
        activeId,
        prev.columnCardIds,
        prev.columns
      );
      const overCol = findContainerOf(overId, prev.columnCardIds, prev.columns);
      if (!activeCol || !overCol) return prev;

      if (activeCol === overCol) return prev; // reorder within same col handled onDragEnd

      const activeList = prev.columnCardIds[activeCol] || [];
      const overList = prev.columnCardIds[overCol] || [];

      const nextActiveList = removeFrom(activeList, activeId);

      let newIndex = overList.length;
      if (!isColumnId(overId, prev.columns)) {
        const overIndex = overList.indexOf(overId);
        newIndex = overIndex >= 0 ? overIndex : overList.length;
      }

      if (overList.includes(activeId)) return prev;

      const nextOverList = insertAt(overList, newIndex, activeId);

      // also update card's columnId locally for UI
      const nextCards = { ...prev.cardsById };
      const c = nextCards[activeId];
      if (c) nextCards[activeId] = { ...c, columnId: overCol };

      return {
        ...prev,
        cardsById: nextCards,
        columnCardIds: {
          ...prev.columnCardIds,
          [activeCol]: nextActiveList,
          [overCol]: nextOverList,
        },
      };
    });
  }

  function handleDragEnd(e: any) {
    if (!board) return;

    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;

    setActiveCardId(null);
    activeCardIdRef.current = null;

    if (!overId) return;
    if (isColumnId(activeId, board.columns)) return;

    // reorder within same column
    setBoard((prev) => {
      if (!prev) return prev;

      const activeCol = findContainerOf(
        activeId,
        prev.columnCardIds,
        prev.columns
      );
      const overCol = findContainerOf(overId, prev.columnCardIds, prev.columns);
      if (!activeCol || !overCol) return prev;

      // if moved across columns, we already updated order in onDragOver
      if (activeCol !== overCol) return prev;

      const list = prev.columnCardIds[activeCol] || [];
      const oldIndex = list.indexOf(activeId);
      if (oldIndex === -1) return prev;

      let newIndex = list.length - 1; // drop on column body -> end
      if (!isColumnId(overId, prev.columns)) {
        const overIndex = list.indexOf(overId);
        if (overIndex !== -1) newIndex = overIndex;
      }

      if (oldIndex === newIndex) return prev;

      return {
        ...prev,
        columnCardIds: {
          ...prev.columnCardIds,
          [activeCol]: arrayMove(list, oldIndex, newIndex),
        },
      };
    });

    // sync only if changed (compare with dragStart snapshot)
    const snap = dragStartRef.current;
    dragStartRef.current = null;

    // ใช้ setTimeout 0 เพื่อให้ state update ด้านบนเสร็จก่อน แล้วค่อยอ่าน state ล่าสุด
    // setTimeout(() => {
    //   const cur = board; // board ใน closure อาจยังเก่า แต่เราจะ sync จาก state ล่าสุดด้วย setBoard callback ไม่ได้ง่าย
    //   // วิธีง่ายและชัวร์: sync จาก state ปัจจุบันจริงด้วย setBoard functional?
    //   // -> แก้: อ่านจาก state ผ่าน setBoard functional โดยคิวงาน sync หลัง setBoard เสร็จ: ใช้ refresh จาก server หลัง sync อยู่แล้ว
    //   // ดังนั้นเราจะ sync โดยใช้ "board ณ ตอนนี้" ไม่เป๊ะ 100% ถ้า drag เร็วมาก
    //   // ทางแก้จริง: ใช้ useRef เก็บ board ล่าสุด
    // }, 0);

    // ✅ ทางชัวร์: เรา sync โดยอิง "board ล่าสุด" ผ่าน ref
    // (อัปเดต ref ทุกครั้งที่ board เปลี่ยนอยู่ด้านล่าง)
    if (!snap) return;

    const latest = boardRef.current;
    if (!latest) return;

    const toCol = findContainerOf(
      activeId,
      latest.columnCardIds,
      latest.columns
    );
    if (!toCol) return;
    const toIndex = (latest.columnCardIds[toCol] || []).indexOf(activeId);

    const changed = snap.fromColId !== toCol || snap.fromIndex !== toIndex;
    if (!changed) return;

    // sync to backend
    void syncMoveCard(activeId);
  }

  // keep latest board in ref for DnD sync
  const boardRef = useRef<BoardState | null>(null);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  if (!board) {
    return (
      <div className="sb-root">
        <style>{css}</style>
        <div className="sb-header">
          <div>
            <div className="sb-title">Sprint Board</div>
            <div className="sb-subtitle">API mode (Fastify + MongoDB)</div>
          </div>
          <div className="sb-actions">
            <input
              className="sb-input sb-input-inline"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="x-account-id"
              title="x-account-id header"
            />
            <button
              className="sb-btn"
              onClick={() => ensureBoard()}
              disabled={loading}
            >
              {loading ? "Loading..." : "Init Board"}
            </button>
          </div>
        </div>

        {errMsg ? <div className="sb-alert">{errMsg}</div> : null}
        <div className="sb-muted">API Base: {getApiBase()}</div>
      </div>
    );
  }

  return (
    <div className="sb-root">
      <style>{css}</style>

      <div className="sb-header">
        <div>
          <div className="sb-title">{board.name || "Sprint Board"}</div>
          <div className="sb-subtitle">
            {/* Board: <span className="sb-mono">{board.boardId}</span> · v
            {board.version} */}
            {loading ? " · syncing..." : ""}
          </div>
        </div>

        <div className="sb-actions">
          {/* <input
            className="sb-input sb-input-inline"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="x-account-id"
            title="x-account-id header"
          /> */}

          <button
            className="sb-btn"
            onClick={() => setModal({ open: true, mode: "create_column" })}
          >
            + Column
          </button>

          <button
            className="sb-btn sb-btn-ghost"
            onClick={() => refresh(board.boardId)}
            disabled={loading}
          >
            Refresh
          </button>

          <button
            className="sb-btn sb-btn-ghost"
            onClick={() => {
              localStorage.removeItem(STORAGE_BOARD_ID);
              setBoard(null);
              ensureBoard();
            }}
            title="Create new board"
          >
            New Board
          </button>
        </div>
      </div>

      {errMsg ? <div className="sb-alert">{errMsg}</div> : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="sb-board">
          {board.columns
            .slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((col) => (
              <ColumnView
                key={col.id}
                col={col}
                columnsCount={board.columns.length}
                cardIds={board.columnCardIds[col.id] || []}
                cardsById={board.cardsById}
                onAddCard={() =>
                  setModal({
                    open: true,
                    mode: "create_card",
                    columnId: col.id,
                  })
                }
                onEditCard={(cardId) =>
                  setModal({ open: true, mode: "edit_card", cardId })
                }
                onRemoveCard={deleteCard}
                onRenameColumn={() =>
                  setModal({
                    open: true,
                    mode: "rename_column",
                    columnId: col.id,
                  })
                }
                onDeleteColumnMoveCards={() => {
                  if (
                    confirm(
                      "Delete this column? Cards will be moved to the first column."
                    )
                  ) {
                    deleteColumn(col.id, "move_cards");
                  }
                }}
                onDeleteColumnAndCards={() => {
                  if (confirm("Delete this column AND all cards in it?")) {
                    deleteColumn(col.id, "delete_cards");
                  }
                }}
              />
            ))}
        </div>

        {activeCard ? (
          <div className="sb-drag-overlay" aria-hidden>
            <div className="sb-card sb-card-overlay">
              <div className="sb-card-top">
                <div className="sb-card-title">
                  {activeCard.title || "(Untitled)"}
                </div>
                <div className="sb-pill">{activeCard.points} pt</div>
              </div>
              {activeCard.description ? (
                <div className="sb-card-desc">{activeCard.description}</div>
              ) : (
                <div className="sb-card-desc sb-muted">No description</div>
              )}
            </div>
          </div>
        ) : null}
      </DndContext>

      {/* Modals */}
      {modal.open && modal.mode === "create_column" && (
        <ColumnModal
          title="Create Column"
          initialValue=""
          onClose={() => setModal({ open: false })}
          onSubmit={(name) => {
            addColumn(name);
            setModal({ open: false });
          }}
        />
      )}

      {modal.open && modal.mode === "rename_column" && (
        <ColumnModal
          title="Rename Column"
          initialValue={
            board.columns.find((c) => c.id === modal.columnId)?.title ?? ""
          }
          onClose={() => setModal({ open: false })}
          onSubmit={(name) => {
            renameColumn(modal.columnId, name);
            setModal({ open: false });
          }}
        />
      )}

      {modal.open && modal.mode === "create_card" && (
        <CardModal
          mode="create"
          card={null}
          onClose={() => setModal({ open: false })}
          onSubmit={(data) => {
            createCard(modal.columnId, data);
            setModal({ open: false });
          }}
        />
      )}

      {modal.open && modal.mode === "edit_card" && (
        <CardModal
          mode="edit"
          card={board.cardsById[modal.cardId]}
          onClose={() => setModal({ open: false })}
          onSubmit={(data) => {
            updateCard(modal.cardId, data);
            setModal({ open: false });
          }}
        />
      )}
    </div>
  );
}

// ---------- UI Components ----------
function ColumnView(props: {
  col: Column;
  columnsCount: number;
  cardIds: string[];
  cardsById: Record<string, Card>;
  onAddCard: () => void;
  onEditCard: (cardId: string) => void;
  onRemoveCard: (cardId: string) => void;
  onRenameColumn: () => void;
  onDeleteColumnMoveCards: () => void;
  onDeleteColumnAndCards: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.col.id });

  return (
    <div className="sb-col">
      <div className="sb-col-header">
        <div className="sb-col-title">{props.col.title}</div>

        <div className="sb-col-tools">
          <button className="sb-btn sb-btn-mini" onClick={props.onAddCard}>
            + Add
          </button>

          <details className="sb-menu">
            <summary className="sb-menu-btn" title="Column menu">
              ⋯
            </summary>
            <div className="sb-menu-pop">
              <button className="sb-menu-item" onClick={props.onRenameColumn}>
                Rename
              </button>

              <div className="sb-menu-sep" />

              <button
                className="sb-menu-item"
                onClick={props.onDeleteColumnMoveCards}
                disabled={props.columnsCount <= 1}
                title={
                  props.columnsCount <= 1 ? "Cannot delete the last column" : ""
                }
              >
                Delete (move cards)
              </button>

              <button
                className="sb-menu-item sb-danger"
                onClick={props.onDeleteColumnAndCards}
                disabled={props.columnsCount <= 1}
                title={
                  props.columnsCount <= 1 ? "Cannot delete the last column" : ""
                }
              >
                Delete + cards
              </button>
            </div>
          </details>
        </div>
      </div>

      <SortableContext
        items={props.cardIds}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={`sb-col-body ${isOver ? "sb-col-over" : ""}`}
        >
          {props.cardIds.length === 0 ? (
            <div className="sb-empty">Drop cards here</div>
          ) : null}

          {props.cardIds.map((cardId) => (
            <SortableCard
              key={cardId}
              card={props.cardsById[cardId]}
              onEdit={() => props.onEditCard(cardId)}
              onRemove={() => props.onRemoveCard(cardId)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableCard(props: {
  card: Card;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.card.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="sb-card">
      <div className="sb-card-top">
        <div className="sb-card-title">{props.card.title || "(Untitled)"}</div>
        <div className="sb-pill">{props.card.points} pt</div>
      </div>

      {props.card.description ? (
        <div className="sb-card-desc">{props.card.description}</div>
      ) : (
        <div className="sb-card-desc sb-muted">No description</div>
      )}

      <div className="sb-card-actions">
        <button
          className="sb-btn sb-btn-mini sb-btn-ghost"
          onClick={props.onEdit}
        >
          Edit
        </button>
        <button
          className="sb-btn sb-btn-mini sb-btn-danger"
          onClick={props.onRemove}
        >
          Delete
        </button>
        <div className="sb-spacer" />
        <button
          className="sb-handle"
          {...attributes}
          {...listeners}
          title="Drag"
        >
          ⠿
        </button>
      </div>
    </div>
  );
}

function CardModal(props: {
  mode: "create" | "edit";
  card: Card | null;
  onClose: () => void;
  onSubmit: (data: {
    title: string;
    description: string;
    points: number;
  }) => void;
}) {
  const [title, setTitle] = useState(props.card?.title ?? "");
  const [description, setDescription] = useState(props.card?.description ?? "");
  const [points, setPoints] = useState(props.card?.points ?? 1);

  useEffect(() => {
    setTitle(props.card?.title ?? "");
    setDescription(props.card?.description ?? "");
    setPoints(props.card?.points ?? 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.card?.id, props.mode]);

  return (
    <div
      className="sb-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div className="sb-modal">
        <div className="sb-modal-title">
          {props.mode === "create" ? "Create Card" : "Edit Card"}
        </div>

        <label className="sb-label">
          Title
          <input
            className="sb-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>

        <label className="sb-label">
          Description
          <textarea
            className="sb-input sb-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="sb-label">
          Points
          <input
            className="sb-input"
            type="number"
            min={0}
            step={1}
            value={points}
            onChange={(e) => setPoints(Number(e.target.value))}
          />
        </label>

        <div className="sb-modal-actions">
          <button className="sb-btn sb-btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="sb-btn"
            onClick={() =>
              props.onSubmit({
                title: title.trim(),
                description: description.trim(),
                points: Number.isFinite(points) ? points : 0,
              })
            }
          >
            {props.mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ColumnModal(props: {
  title: string;
  initialValue: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(props.initialValue);

  useEffect(() => setName(props.initialValue), [props.initialValue]);

  return (
    <div
      className="sb-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div className="sb-modal">
        <div className="sb-modal-title">{props.title}</div>

        <label className="sb-label">
          Column name
          <input
            className="sb-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>

        <div className="sb-modal-actions">
          <button className="sb-btn sb-btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="sb-btn" onClick={() => props.onSubmit(name)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const css = `
.sb-root{font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; padding:18px; color:#0f172a; background:#f8fafc; min-height:100vh;}
.sb-header{display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:14px;}
.sb-title{font-size:22px; font-weight:800;}
.sb-subtitle{font-size:13px; color:#64748b; margin-top:4px;}
.sb-actions{display:flex; gap:8px; align-items:center;}
.sb-board{display:grid; grid-template-columns: repeat(3, minmax(260px, 1fr)); gap:14px; align-items:start;}

.sb-col{background:#fff; border:1px solid #e2e8f0; border-radius:14px; box-shadow:0 1px 0 rgba(15,23,42,0.03); overflow:visible;}
.sb-col-header{display:flex; align-items:center; justify-content:space-between; padding:12px 12px 10px; border-bottom:1px solid #eef2f7; background:#fbfdff;}
.sb-col-title{font-weight:800;}
.sb-col-tools{display:flex; gap:8px; align-items:center;}
.sb-col-body{padding:12px; min-height:260px; display:flex; flex-direction:column; gap:10px;}
.sb-col-over{background:#f1f5f9;}
.sb-empty{border:1px dashed #cbd5e1; border-radius:12px; padding:12px; color:#94a3b8; text-align:center; background:#f8fafc;}

.sb-card{background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:10px 10px 8px; box-shadow:0 1px 0 rgba(15,23,42,0.03);}
.sb-card-top{display:flex; align-items:flex-start; justify-content:space-between; gap:8px;}
.sb-card-title{font-weight:800; font-size:14px; line-height:1.25;}
.sb-card-desc{margin-top:6px; font-size:12.5px; color:#334155; white-space:pre-wrap; word-break:break-word;}
.sb-muted{color:#94a3b8;}
.sb-card-actions{margin-top:10px; display:flex; gap:8px; align-items:center;}
.sb-spacer{flex:1;}
.sb-handle{cursor:grab; border:1px solid #e2e8f0; background:#f8fafc; border-radius:10px; padding:6px 10px; font-size:14px;}
.sb-handle:active{cursor:grabbing;}
.sb-pill{font-size:12px; background:#f1f5f9; border:1px solid #e2e8f0; color:#0f172a; padding:2px 8px; border-radius:999px; white-space:nowrap;}

.sb-btn{border:1px solid #0f172a; background:#0f172a; color:#fff; border-radius:12px; padding:10px 12px; font-weight:700; font-size:13px; cursor:pointer;}
.sb-btn:hover{filter:brightness(1.06);}
.sb-btn:active{transform:translateY(1px);}
.sb-btn-ghost{background:#fff; color:#0f172a; border-color:#cbd5e1;}
.sb-btn-mini{padding:6px 10px; font-size:12px; border-radius:10px;}
.sb-btn-danger{background:#fff1f2; color:#9f1239; border-color:#fecdd3;}

.sb-input{border:1px solid #cbd5e1; border-radius:12px; padding:10px 12px; font-size:13px; outline:none; background:#fff;}
.sb-input:focus{border-color:#0f172a; box-shadow:0 0 0 3px rgba(15,23,42,0.08);}
.sb-input-inline{width:180px;}

.sb-modal-backdrop{position:fixed; inset:0; background:rgba(15,23,42,0.42); display:flex; align-items:center; justify-content:center; padding:16px; z-index:1000;}
.sb-modal{width:min(520px, 100%); background:#fff; border-radius:16px; border:1px solid #e2e8f0; padding:14px; box-shadow:0 12px 40px rgba(15,23,42,0.18);}
.sb-modal-title{font-weight:900; font-size:16px; margin-bottom:10px;}
.sb-label{display:flex; flex-direction:column; gap:6px; font-size:12px; color:#334155; margin-top:10px;}
.sb-textarea{min-height:90px; resize:vertical;}
.sb-modal-actions{display:flex; justify-content:flex-end; gap:10px; margin-top:14px;}

.sb-drag-overlay{position:fixed; pointer-events:none; left:18px; bottom:18px; z-index:1200; width:min(360px, calc(100vw - 36px));}
.sb-card-overlay{box-shadow:0 14px 50px rgba(15,23,42,0.25); border-color:#0f172a22;}

.sb-menu{position:relative;}
.sb-menu-btn{
  list-style:none;
  cursor:pointer;
  border:1px solid #cbd5e1;
  background:#fff;
  border-radius:10px;
  padding:6px 10px;
  font-weight:900;
  line-height:1;
}
.sb-menu[open] .sb-menu-btn{border-color:#0f172a; box-shadow:0 0 0 3px rgba(15,23,42,0.08);}
.sb-menu-pop{
  position:absolute;
  right:0;
  margin-top:8px;
  background:#fff;
  border:1px solid #e2e8f0;
  border-radius:12px;
  box-shadow:0 12px 40px rgba(15,23,42,0.12);
  padding:6px;
  min-width:180px;
  z-index:10;
}
.sb-menu-item{
  width:100%;
  text-align:left;
  border:none;
  background:transparent;
  padding:8px 10px;
  border-radius:10px;
  cursor:pointer;
  font-weight:700;
}
.sb-menu-item:hover{background:#f1f5f9;}
.sb-menu-item:disabled{opacity:0.5; cursor:not-allowed;}
.sb-danger{color:#9f1239;}
.sb-menu-sep{height:1px; background:#eef2f7; margin:6px 0;}

.sb-alert{
  background:#fff7ed;
  border:1px solid #fed7aa;
  color:#9a3412;
  padding:10px 12px;
  border-radius:12px;
  margin:10px 0 14px;
}
.sb-mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;}
`;
