import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  annotBox,
  commitDocument,
  commitForm,
  commitItems,
  isMarkup,
  newId,
  previewItems,
  redo,
  undo,
  type Annotation,
  type AnnotKind,
  type DocState,
  type Tool,
} from '../lib/annotations';
import { emptyValue, uniqueFieldName, widgetFromDef, type FieldDef, type FieldKind, type FieldValue, type FieldValues, type Widget } from '../lib/forms';
import { pageMatrix, type Box } from '../lib/geometry';
import { loadSignatures, storeSignatures, type SavedSignature, type SignatureRole } from '../lib/signatures';
import { CSS_UNITS, resolveDest, type OutlineNode } from '../lib/pdf';
import { openExternal } from '../lib/platform';
import { makeMatcher, searchDocument, type SearchHit } from '../lib/search';
import { readSelection } from '../lib/selection';
import type { ThemePref } from '../lib/theme';
import { clampScale, stepZoom, type DocTab, type DocView, type LinkTarget, type Zoom } from '../lib/view';
import { AnnotateBar, TOOL_KEYS } from './AnnotateBar';
import type { DigitalSignPlan } from './DigitalSignDialog';
import { SignatureBanner } from './SignatureBanner';
import { SignatureDialog } from './SignatureDialog';
// Digital IDs pull in the crypto library, so the dialog loads when first opened.
const DigitalSignDialog = lazy(() => import('./DigitalSignDialog').then((m) => ({ default: m.DigitalSignDialog })));
import { SignMenu } from './SignMenu';
import type { FormApi, FormUi } from './FormLayer';
import { FormsBar } from './FormsBar';
import type { OrganizeApi, OutputPart } from './OrganizeView';
// Organizing pulls in pdf-lib, so it loads when first opened.
const OrganizeView = lazy(() => import('./OrganizeView').then((m) => ({ default: m.OrganizeView })));
import type { AnnotApi, AnnotUi, ToolStyle } from './AnnotationLayer';
import { SearchBar } from './SearchBar';
import { Sidebar, type SidebarPanel } from './Sidebar';
import { Toolbar } from './Toolbar';
import { Viewer, type ViewerApi } from './Viewer';

export interface KindStyle {
  color: string;
  opacity: number;
  width: number;
}

export interface Styles {
  kinds: Record<AnnotKind, KindStyle>;
  fontSize: number;
  stamp: string;
}

interface Props {
  tab: DocTab;
  sidebarOpen: boolean;
  sidebarPanel: SidebarPanel;
  night: boolean;
  theme: ThemePref;
  findNonce: number;
  annotateOpen: boolean;
  organizeOpen: boolean;
  formsOpen: boolean;
  /** Changes when the toolbar's Sign button is pressed. */
  signNonce: number;
  organizeApi: React.RefObject<OrganizeApi | null>;
  styles: Styles;
  author: string;
  dirty: boolean;
  onView: (patch: Partial<DocView>) => void;
  onAnnots: (update: (s: DocState) => DocState) => void;
  onStyles: (update: (s: Styles) => Styles) => void;
  onAuthor: (name: string) => void;
  onSave: () => void;
  onToggleAnnotate: () => void;
  onToggleOrganize: () => void;
  onToggleForms: () => void;
  onCompress: () => void;
  onOpenNew: (name: string, base: Uint8Array, items: Annotation[], defs: FieldDef[], fields: FieldValues) => void;
  onSaveParts: (makeParts: () => Promise<OutputPart[]>) => Promise<void>;
  onError: (message: string) => void;
  /** Sign with a digital ID: placement null = invisible signature. */
  onDigitalSign: (plan: DigitalSignPlan, placement: { page: number; box: Box; fieldName?: string } | null) => void;
  onToggleSidebar: () => void;
  onSidebarPanel: (panel: SidebarPanel) => void;
  onToggleNight: () => void;
  onCycleTheme: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

const replaceItem = (list: Annotation[], a: Annotation) => list.map((x) => (x.id === a.id ? a : x));

/** Tools that stay active after use; the rest switch back to Select so the new item can be adjusted. */
const STICKY_TOOLS: Tool[] = ['highlight', 'underline', 'strike', 'ink'];

export function DocumentView(props: Props) {
  const { tab, onView, onAnnots } = props;
  const { doc, sizes, view } = tab;
  const items = tab.annots.items;
  const viewerApi = useRef<ViewerApi | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // ----- search -----
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeHit, setActiveHit] = useState(-1);

  useEffect(() => {
    if (props.findNonce === 0) return;
    setSearchOpen(true);
    setFocusNonce((n) => n + 1);
  }, [props.findNonce]);

  useEffect(() => {
    const matcher = searchOpen ? makeMatcher(query, matchCase) : null;
    setHits([]);
    setActiveHit(-1);
    if (!matcher) {
      setSearching(false);
      return;
    }
    const abort = new AbortController();
    let first = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchDocument(doc, matcher, abort.signal, (found) => {
        if (abort.signal.aborted) return;
        setHits(found);
        // Jump to the first result at or after the current page as soon as one exists.
        if (first && found.length) {
          first = false;
          const page = viewRef.current.page;
          const next = found.find((h) => h.page >= page) ?? found[0];
          setActiveHit(next.id);
        }
      }).finally(() => !abort.signal.aborted && setSearching(false));
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [doc, query, matchCase, searchOpen]);

  const hitsByPage = useMemo(() => {
    const map = new Map<number, SearchHit[]>();
    for (const h of hits) {
      const list = map.get(h.page);
      if (list) list.push(h);
      else map.set(h.page, [h]);
    }
    return map;
  }, [hits]);

  // Make sure the page holding the active result is on screen; the page then centres the highlight.
  useEffect(() => {
    const hit = hits[activeHit];
    if (hit && !viewerApi.current?.isMounted(hit.page)) viewerApi.current?.goTo(hit.page);
    // Only when the active result changes, not when more results stream in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHit]);

  const stepHit = (direction: 1 | -1) => {
    if (!hits.length) return;
    setActiveHit((i) => (i < 0 ? 0 : (i + direction + hits.length) % hits.length));
  };

  const closeSearch = () => {
    setSearchOpen(false);
    document.querySelector<HTMLElement>('.viewer')?.focus();
  };

  // ----- annotations -----
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [commentId, setCommentId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const editingRef = useRef(editingId);
  editingRef.current = editingId;
  /** Items as they were before a drag or typing session began; that session becomes one undo step. */
  const pending = useRef<Annotation[] | null>(null);

  const onAnnotsRef = useRef(onAnnots);
  onAnnotsRef.current = onAnnots;
  const finalizePending = useCallback(() => {
    const prev = pending.current;
    if (!prev) return;
    pending.current = null;
    onAnnotsRef.current((s) => (s.items === prev ? s : commitItems(s, s.items, prev)));
  }, []);

  useEffect(() => {
    if (!props.annotateOpen) setTool('select');
  }, [props.annotateOpen]);

  // Leaving the document (switching tab) keeps any half-finished edit.
  useEffect(() => () => finalizePending(), [finalizePending]);

  const annotsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of items) {
      const list = map.get(a.page);
      if (list) list.push(a);
      else map.set(a.page, [a]);
    }
    return map;
  }, [items]);

  const selected = items.find((a) => a.id === selectedId) ?? null;

  // Drop selection if the item disappears (undo, delete).
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
    if (editingId && !items.some((a) => a.id === editingId)) setEditingId(null);
    if (commentId && !items.some((a) => a.id === commentId)) setCommentId(null);
  }, [items, selectedId, selected, editingId, commentId]);

  const api = useRef<AnnotApi>(null!);
  api.current = {
    create(a) {
      finalizePending();
      if (a.kind === 'text') {
        // Not an undo step until the user has typed something.
        pending.current = itemsRef.current;
        onAnnots((s) => previewItems(s, [...s.items, a]));
        setEditingId(a.id);
      } else {
        onAnnots((s) => commitItems(s, [...s.items, a]));
      }
      if (!STICKY_TOOLS.includes(a.kind)) {
        setTool('select');
        setSelectedId(a.id);
      }
      if (a.kind === 'note') setCommentId(a.id);
    },
    update(a, final) {
      if (!final) {
        if (!pending.current) pending.current = itemsRef.current;
        onAnnots((s) => previewItems(s, replaceItem(s.items, a)));
        return;
      }
      const prev = pending.current;
      pending.current = null;
      onAnnots((s) => {
        if (!prev && s.items.find((x) => x.id === a.id) === a) return s;
        return commitItems(s, replaceItem(s.items, a), prev ?? s.items);
      });
    },
    remove(id) {
      const prev = pending.current;
      pending.current = null;
      onAnnots((s) => {
        // Removing something made during the pending edit (an empty text box) leaves no trace.
        if (prev && !prev.some((x) => x.id === id)) return previewItems(s, prev);
        return commitItems(s, s.items.filter((x) => x.id !== id), prev ?? s.items);
      });
      if (selectedRef.current === id) setSelectedId(null);
      setEditingId((e) => (e === id ? null : e));
      setCommentId((c) => (c === id ? null : c));
    },
    select(id) {
      if (id !== selectedRef.current && !editingRef.current) finalizePending();
      setSelectedId(id);
      if (id === null) setCommentId(null);
    },
    editText(id) {
      setEditingId(id);
      if (id) setSelectedId(id);
    },
    openComment(id) {
      if (!id) finalizePending();
      setCommentId(id);
      if (id) setSelectedId(id);
    },
    placeBox(page, box) {
      const plan = digitalPlanRef.current;
      setTool('select');
      setDigitalPlan(null);
      if (plan) props.onDigitalSign(plan, { page, box });
    },
  };
  const stableApi = useMemo<AnnotApi>(
    () => ({
      create: (a) => api.current.create(a),
      update: (a, f) => api.current.update(a, f),
      remove: (id) => api.current.remove(id),
      select: (id) => api.current.select(id),
      editText: (id) => api.current.editText(id),
      openComment: (id) => api.current.openComment(id),
      placeBox: (page, box) => api.current.placeBox(page, box),
    }),
    [],
  );

  // ----- signatures -----
  const [signatures, setSignatures] = useState<SavedSignature[]>(loadSignatures);
  const [signMenuOpen, setSignMenuOpen] = useState(false);
  const [sigDialog, setSigDialog] = useState<SignatureRole | null>(null);
  const [pendingImage, setPendingImage] = useState<ToolStyle['image'] | null>(null);
  /** A "Sign here" field being filled: the signature goes into its box. */
  const [signTarget, setSignTarget] = useState<{ page: number; box: Box; fieldName?: string } | null>(null);
  const [digitalOpen, setDigitalOpen] = useState(false);
  /** Unlocked ID waiting for the user to mark where the signature goes. */
  const [digitalPlan, setDigitalPlan] = useState<DigitalSignPlan | null>(null);
  const digitalPlanRef = useRef(digitalPlan);
  digitalPlanRef.current = digitalPlan;
  const locked = !!tab.readOnly; // signed or encrypted: no edits, but signed files can still be signed again
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const onDigitalReady = (plan: DigitalSignPlan) => {
    setDigitalOpen(false);
    if (signTarget?.fieldName) {
      props.onDigitalSign(plan, { page: signTarget.page, box: signTarget.box, fieldName: signTarget.fieldName });
      setSignTarget(null);
    } else if (!plan.visible) {
      props.onDigitalSign(plan, null);
    } else {
      setDigitalPlan(plan);
      setTool('sigbox');
      setSelectedId(null);
    }
  };

  useEffect(() => {
    if (props.signNonce) setSignMenuOpen(true);
  }, [props.signNonce]);

  const placeSignature = (sig: SavedSignature) => {
    setSignMenuOpen(false);
    const image = { src: sig.src, width: sig.width, height: sig.height, role: sig.role };
    if (signTarget) {
      // Fit inside the field, keeping the signature's shape, centred.
      const { box } = signTarget;
      const bw = box.x2 - box.x1;
      const bh = box.y2 - box.y1;
      const scale = Math.min(bw / sig.width, bh / sig.height) * 0.92;
      const w = sig.width * scale;
      const h = sig.height * scale;
      const cx = (box.x1 + box.x2) / 2;
      const cy = (box.y1 + box.y2) / 2;
      const now = new Date().toISOString();
      const a: Annotation = {
        id: newId(),
        kind: 'image',
        page: signTarget.page,
        src: sig.src,
        role: sig.role,
        box: { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 },
        color: '#111111',
        opacity: 1,
        comment: '',
        author: props.author,
        created: now,
        modified: now,
      };
      finalizePending();
      onAnnots((s) => commitItems(s, [...s.items, a]));
      setSignTarget(null);
      return;
    }
    setPendingImage(image);
    setTool('image');
    setSelectedId(null);
  };

  const onSignatureMade = (sig: SavedSignature, remember: boolean) => {
    setSigDialog(null);
    if (remember) {
      const next = [sig, ...signatures].slice(0, 12);
      if (storeSignatures(next)) setSignatures(next);
      else props.onError("Couldn't save the signature on this device (storage is full or blocked). It's used just this once.");
    }
    placeSignature(sig);
  };

  const removeSignature = (id: string) => {
    const next = signatures.filter((s) => s.id !== id);
    storeSignatures(next);
    setSignatures(next);
  };

  // Style shown in the bar: the selected annotation's, or the current tool's defaults.
  const { styles } = props;
  const styleKind: AnnotKind | null = selected ? selected.kind : tool === 'select' ? null : tool === 'date' ? 'text' : tool === 'sigbox' ? 'rect' : tool;
  const kindStyle = styleKind ? styles.kinds[styleKind] : styles.kinds.highlight;
  const toolStyle: ToolStyle = useMemo(
    () => ({
      color: selected?.color ?? kindStyle.color,
      opacity: selected?.opacity ?? kindStyle.opacity,
      width: selected && 'width' in selected ? selected.width : kindStyle.width,
      fontSize: selected?.kind === 'text' ? selected.fontSize : styles.fontSize,
      stamp: styles.stamp,
      image: pendingImage ?? undefined,
    }),
    [selected, kindStyle, styles.fontSize, styles.stamp, pendingImage],
  );

  const changeStyle = (patch: Partial<ToolStyle>) => {
    if (styleKind) {
      props.onStyles((s) => ({
        ...s,
        fontSize: patch.fontSize ?? s.fontSize,
        stamp: patch.stamp ?? s.stamp,
        kinds: {
          ...s.kinds,
          [styleKind]: {
            ...s.kinds[styleKind],
            ...(patch.color ? { color: patch.color } : {}),
            ...(patch.width ? { width: patch.width } : {}),
          },
        },
      }));
    }
    if (selected) {
      const next = { ...selected, modified: new Date().toISOString() } as Annotation;
      if (patch.color) next.color = patch.color;
      if (patch.width && 'width' in next) next.width = patch.width;
      if (patch.fontSize && next.kind === 'text') next.fontSize = patch.fontSize;
      stableApi.update(next, true);
    }
  };

  const annotUi: AnnotUi = useMemo(
    () => ({ tool, style: toolStyle, author: props.author, selectedId, editingId, commentId, api: stableApi }),
    [tool, toolStyle, props.author, selectedId, editingId, commentId, stableApi],
  );

  const matrixFor = useCallback(
    (page: number) => {
      const s = sizes[page];
      return pageMatrix(s.view, (s.rotate + viewRef.current.rotation) % 360, viewRef.current.scale * CSS_UNITS);
    },
    [sizes],
  );

  // Highlight / underline / strikethrough: select text with the tool active.
  const onPointerUp = () => {
    if (!isMarkup(tool)) return;
    window.setTimeout(() => {
      const found = readSelection(matrixFor);
      if (!found.length) return;
      const now = new Date().toISOString();
      const style = styles.kinds[tool];
      const created: Annotation[] = found.map((f) => ({
        id: newId(),
        kind: tool,
        page: f.page,
        quads: f.quads,
        text: f.text,
        color: style.color,
        opacity: style.opacity,
        comment: '',
        author: props.author,
        created: now,
        modified: now,
      }));
      finalizePending();
      onAnnots((s) => commitItems(s, [...s.items, ...created]));
      window.getSelection()?.removeAllRanges();
    }, 0);
  };

  // Clicking empty space deselects.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.annot-hit, .annot-frame, .annot-handle, .annot-textarea, .comment-pop, .annotatebar, .sidebar'))
      return;
    if (selectedRef.current && !editingRef.current) stableApi.select(null);
  };

  const focusAnnotation = (a: Annotation) => {
    const box = annotBox(a);
    viewerApi.current?.goTo(a.page, box.y2 + 40);
    stableApi.select(a.id);
  };

  // ----- navigation -----
  const goToPage = useCallback(
    (index: number) => viewerApi.current?.goTo(Math.min(sizes.length - 1, Math.max(0, index))),
    [sizes.length],
  );

  const followLink = useCallback(
    async (link: LinkTarget | OutlineNode) => {
      if (link.url) {
        await openExternal(link.url);
        return;
      }
      const target = await resolveDest(doc, link.dest);
      if (target) viewerApi.current?.goTo(target.pageIndex, target.top);
    },
    [doc],
  );

  // ----- forms -----
  const { fields: values, defs } = tab.annots;
  const [formTool, setFormTool] = useState<'select' | FieldKind>('select');
  const [selectedDefId, setSelectedDefId] = useState<string | null>(null);
  const [highlightFields, setHighlightFields] = useState(true);
  /** Fields already in the file (name → kind), for "Clear form" and unique names. */
  const [docFields, setDocFields] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void doc.getFieldObjects().then((objs) => {
      if (cancelled || !objs) return;
      const map = new Map<string, string>();
      for (const [name, list] of Object.entries(objs)) {
        const type = (list as { type?: string }[]).find((o) => o.type)?.type;
        if (type) map.set(name, type);
      }
      setDocFields(map);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    if (!props.formsOpen) {
      setFormTool('select');
      setSelectedDefId(null);
    }
  }, [props.formsOpen]);

  const selectedDef = defs.find((d) => d.id === selectedDefId) ?? null;
  const hasForm = docFields.size > 0 || defs.length > 0;

  const placedByPage = useMemo(() => {
    const map = new Map<number, Widget[]>();
    for (const d of defs) {
      const list = map.get(d.page);
      if (list) list.push(widgetFromDef(d));
      else map.set(d.page, [widgetFromDef(d)]);
    }
    return map;
  }, [defs]);

  const takenNames = useMemo(() => new Set([...docFields.keys(), ...defs.map((d) => d.name)]), [docFields, defs]);
  const takenOthers = useMemo(() => {
    const set = new Set(docFields.keys());
    for (const d of defs) if (d.id !== selectedDefId && !(selectedDef?.kind === 'radio' && d.name === selectedDef.name)) set.add(d.name);
    return set;
  }, [docFields, defs, selectedDefId, selectedDef]);

  const formState = useRef({ selectedDef, takenNames, defs });
  formState.current = { selectedDef, takenNames, defs };

  const formApi = useMemo<FormApi>(
    () => ({
      setValue: (name: string, value: FieldValue) =>
        onAnnotsRef.current((s) => (s.fields[name] === value ? s : commitForm(s, { fields: { ...s.fields, [name]: value } }))),
      selectDef: (id) => setSelectedDefId(id),
      signField: (page, box, name) => {
        setSignTarget({ page, box, fieldName: name });
        // A signed file can only take digital signatures; otherwise offer the menu.
        if (lockedRef.current) setDigitalOpen(true);
        else setSignMenuOpen(true);
      },
      createDef: (def: FieldDef) => {
        onAnnotsRef.current((s) => commitForm(s, { defs: [...s.defs, def] }));
        setSelectedDefId(def.id);
        // Radio buttons usually come several at a time; other tools go back to Select.
        if (def.kind !== 'radio') setFormTool('select');
      },
      updateDef: (def: FieldDef) =>
        onAnnotsRef.current((s) => {
          const old = s.defs.find((d) => d.id === def.id);
          if (!old) return s;
          // Renaming a radio button renames its whole group.
          const renamedGroup = old.kind === 'radio' && old.name !== def.name;
          const nextDefs = s.defs.map((d) => (d.id === def.id ? def : renamedGroup && d.kind === 'radio' && d.name === old.name ? { ...d, name: def.name } : d));
          let fields = s.fields;
          if (old.name !== def.name && Object.prototype.hasOwnProperty.call(fields, old.name)) {
            const { [old.name]: v, ...rest } = fields;
            fields = { ...rest, [def.name]: v };
          }
          return commitForm(s, { defs: nextDefs, fields });
        }),
    }),
    [],
  );

  const newDef = useCallback(
    (kind: FieldKind, page: number, box: FieldDef['box']): FieldDef => {
      const { selectedDef: sel, takenNames: taken, defs: all } = formState.current;
      const base = { id: newId(), kind, page, box, required: false };
      if (kind === 'radio') {
        // Join the selected group, or start a new one.
        const group = sel?.kind === 'radio' ? sel.name : uniqueFieldName('Radio group', taken);
        const count = all.filter((d) => d.kind === 'radio' && d.name === group).length;
        return { ...base, name: group, radioValue: `Choice ${count + 1}` };
      }
      const prefix = kind === 'text' ? 'Text' : kind === 'checkbox' ? 'Checkbox' : 'Dropdown';
      return {
        ...base,
        name: uniqueFieldName(prefix, taken),
        ...(kind === 'text' ? { fontSize: 0, multiline: box.y2 - box.y1 > 40 } : {}),
        ...(kind === 'dropdown' ? { fontSize: 0, options: ['Option 1', 'Option 2', 'Option 3'] } : {}),
      };
    },
    [],
  );

  const formUi: FormUi = useMemo(
    () => ({
      values,
      highlight: highlightFields,
      designing: props.formsOpen,
      locked: !!tab.readOnly,
      tool: formTool,
      selectedDefId,
      newDef,
      api: formApi,
    }),
    [values, highlightFields, props.formsOpen, tab.readOnly, formTool, selectedDefId, newDef, formApi],
  );

  const clearForm = () => {
    const cleared: FieldValues = {};
    const empty: Record<string, FieldValue> = { text: '', checkbox: false, radiobutton: 'Off', combobox: '', listbox: [] };
    for (const [name, type] of docFields) if (type in empty) cleared[name] = empty[type];
    for (const d of defs) cleared[d.name] = emptyValue(widgetFromDef(d));
    onAnnots((s) => commitForm(s, { fields: cleared }));
  };

  const deleteDef = (id: string) => {
    onAnnots((s) => commitForm(s, { defs: s.defs.filter((d) => d.id !== id) }));
    setSelectedDefId(null);
  };

  const keyState = useRef({ tool, selectedId, searchOpen, annotateOpen: props.annotateOpen, readOnly: tab.readOnly, organizing: props.organizeOpen, selectedDefId });
  keyState.current = { tool, selectedId, searchOpen, annotateOpen: props.annotateOpen, readOnly: tab.readOnly, organizing: props.organizeOpen, selectedDefId };
  const deleteDefRef = useRef(deleteDef);
  deleteDefRef.current = deleteDef;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyState.current;
      // The organize view has its own keys.
      if (k.organizing || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const page = viewRef.current.page;
      if ((e.key === 'Delete' || e.key === 'Backspace') && k.selectedDefId) deleteDefRef.current(k.selectedDefId);
      else if (e.key === 'Escape' && k.selectedDefId) setSelectedDefId(null);
      else if (e.key === 'Escape' && digitalPlanRef.current) {
        setDigitalPlan(null);
        setTool('select');
      }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && k.selectedId) stableApi.remove(k.selectedId);
      else if (e.key === 'Escape' && k.selectedId) stableApi.select(null);
      else if (e.key === 'Escape' && k.tool !== 'select') setTool('select');
      else if (e.key === 'Escape' && k.searchOpen) closeSearch();
      else if (k.annotateOpen && !e.shiftKey && TOOL_KEYS[e.key.toLowerCase()] && !k.readOnly) setTool(TOOL_KEYS[e.key.toLowerCase()]);
      else if (e.key === 'ArrowLeft') goToPage(page - 1);
      else if (e.key === 'ArrowRight') goToPage(page + 1);
      else if (e.key === 'Home') goToPage(0);
      else if (e.key === 'End') goToPage(sizes.length - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToPage, sizes.length, stableApi]);

  // ----- zoom -----
  const setZoom = (zoom: Zoom) => onView({ zoom });
  const zoomBy = useCallback(
    (factor: number) => {
      const scale = clampScale(viewRef.current.scale * factor);
      onView({ zoom: Math.round(scale * 100) / 100 });
    },
    [onView],
  );

  return (
    <div className="document">
      <Toolbar
        page={view.page}
        pageCount={sizes.length}
        zoom={view.zoom}
        scale={view.scale}
        sidebarOpen={props.sidebarOpen}
        searchOpen={searchOpen}
        annotateOpen={props.annotateOpen}
        formsOpen={props.formsOpen}
        organizeOpen={props.organizeOpen}
        canEdit={!tab.readOnly}
        canSign={!tab.readOnly || tab.signed}
        dirty={props.dirty}
        night={props.night}
        theme={props.theme}
        onToggleSidebar={props.onToggleSidebar}
        onGoToPage={goToPage}
        onZoom={setZoom}
        onZoomStep={(d) => setZoom(stepZoom(view.scale, d))}
        onRotate={() => onView({ rotation: (view.rotation + 90) % 360 })}
        onToggleSearch={() => {
          if (searchOpen) closeSearch();
          else {
            setSearchOpen(true);
            setFocusNonce((n) => n + 1);
          }
        }}
        onToggleAnnotate={props.onToggleAnnotate}
        onToggleForms={props.onToggleForms}
        onSign={() => {
          setSignTarget(null);
          setSignMenuOpen((v) => !v);
        }}
        onToggleOrganize={props.onToggleOrganize}
        onCompress={props.onCompress}
        onSave={props.onSave}
        onToggleNight={props.onToggleNight}
        onCycleTheme={props.onCycleTheme}
      />
      {props.organizeOpen && tab.docBase !== tab.annots.base && <div className="organize-loading">Updating pages…</div>}
      {props.organizeOpen && tab.docBase === tab.annots.base && (
        <Suspense fallback={<div className="organize-loading">Loading…</div>}>
        <OrganizeView
          // A fresh grid whenever the document changes underneath.
          key={tab.annots.base.length + ':' + sizes.length}
          name={tab.name}
          doc={doc}
          base={tab.annots.base}
          items={items}
          sizes={sizes}
          apiRef={props.organizeApi}
          defs={defs}
          fields={values}
          onApply={(base, nextItems, nextDefs, nextFields) => {
            finalizePending();
            onAnnots((s) => commitDocument(s, base, nextItems, nextDefs, nextFields));
            props.onToggleOrganize();
          }}
          onClose={props.onToggleOrganize}
          onOpenNew={props.onOpenNew}
          onSaveParts={props.onSaveParts}
          onError={props.onError}
        />
        </Suspense>
      )}
      {props.formsOpen && !props.organizeOpen && (
        <FormsBar
          tool={formTool}
          selected={selectedDef}
          highlight={highlightFields}
          readOnly={tab.readOnly}
          takenNames={takenOthers}
          onTool={(t) => {
            setFormTool(t);
            if (t !== 'radio') setSelectedDefId(null);
          }}
          onHighlight={setHighlightFields}
          onClear={clearForm}
          onChange={(d) => formApi.updateDef(d)}
          onDelete={() => selectedDefId && deleteDef(selectedDefId)}
        />
      )}
      {!props.formsOpen && !props.organizeOpen && hasForm && !props.annotateOpen && (
        <div className="form-notice">
          This document has fillable fields.
          <label className="bar-check">
            <input type="checkbox" checked={highlightFields} onChange={(e) => setHighlightFields(e.target.checked)} />
            Highlight fields
          </label>
          {!locked && (
            <button className="plain-btn small" onClick={clearForm}>
              Clear form
            </button>
          )}
        </div>
      )}
      {props.annotateOpen && !props.organizeOpen && !props.formsOpen && (
        <AnnotateBar
          tool={tool}
          style={toolStyle}
          selected={selected}
          canUndo={tab.annots.past.length > 0}
          canRedo={tab.annots.future.length > 0}
          readOnly={tab.readOnly}
          onTool={(t) => {
            finalizePending();
            setTool(t);
            setSelectedId(null);
            setCommentId(null);
          }}
          onStyle={changeStyle}
          onUndo={() => {
            finalizePending();
            onAnnots(undo);
          }}
          onRedo={() => onAnnots(redo)}
          onDelete={() => selectedId && stableApi.remove(selectedId)}
          onComment={() => selectedId && stableApi.openComment(selectedId)}
        />
      )}
      {tab.signed && <SignatureBanner signatures={tab.signatures} checking={!tab.signatures} />}
      {signMenuOpen && (
        <SignMenu
          signatures={signatures}
          forField={!!signTarget}
          canDigitallySign={!tab.readOnly || tab.signed}
          visualAllowed={!locked}
          onPick={placeSignature}
          onNew={(role) => {
            setSignMenuOpen(false);
            setSigDialog(role);
          }}
          onDate={() => {
            setSignMenuOpen(false);
            setTool('date');
            setSelectedId(null);
          }}
          onDelete={removeSignature}
          onDigital={() => {
            setSignMenuOpen(false);
            setDigitalOpen(true);
          }}
          onClose={() => {
            setSignMenuOpen(false);
            setSignTarget(null);
          }}
        />
      )}
      {digitalOpen && (
        <Suspense fallback={null}>
          <DigitalSignDialog
            signatures={signatures}
            forField={!!signTarget?.fieldName}
            onReady={onDigitalReady}
            onClose={() => {
              setDigitalOpen(false);
              setSignTarget(null);
            }}
          />
        </Suspense>
      )}
      {digitalPlan && (
        <div className="place-hint" role="status">
          Drag a box where your signature should go, or click to use the usual size.
          <button className="plain-btn small" onClick={() => { setDigitalPlan(null); setTool('select'); }}>
            Cancel
          </button>
        </div>
      )}
      {sigDialog && (
        <SignatureDialog
          role={sigDialog}
          onDone={onSignatureMade}
          onClose={() => {
            setSigDialog(null);
            setSignTarget(null);
          }}
        />
      )}
      <div
        className="document-body"
        hidden={props.organizeOpen}
        onPointerDownCapture={onPointerDownCapture}
        onPointerUp={onPointerUp}
      >
        {props.sidebarOpen && (
          <Sidebar
            doc={doc}
            sizes={sizes}
            rotation={view.rotation}
            outline={tab.outline}
            page={view.page}
            panel={props.sidebarPanel}
            annotations={items}
            selectedId={selectedId}
            author={props.author}
            onAuthor={props.onAuthor}
            onPanelChange={props.onSidebarPanel}
            onGoToPage={goToPage}
            onOutline={(node) => void followLink(node)}
            onFocusAnnotation={focusAnnotation}
            onComment={(a, final) => stableApi.update(a, final)}
            onDeleteAnnotation={(id) => stableApi.remove(id)}
          />
        )}
        <div className="viewer-wrap">
          {searchOpen && (
            <SearchBar
              query={query}
              matchCase={matchCase}
              total={hits.length}
              active={activeHit}
              searching={searching}
              focusNonce={focusNonce}
              onQuery={setQuery}
              onMatchCase={setMatchCase}
              onStep={stepHit}
              onClose={closeSearch}
            />
          )}
          <Viewer
            doc={doc}
            sizes={sizes}
            zoom={view.zoom}
            rotation={view.rotation}
            initialPage={view.page}
            night={props.night}
            hitsByPage={hitsByPage}
            activeHit={activeHit}
            apiRef={viewerApi}
            annotsByPage={annotsByPage}
            placedByPage={placedByPage}
            formUi={formUi}
            annotUi={annotUi}
            onPageChange={(page) => onView({ page })}
            onScaleChange={(scale) => onView({ scale })}
            onZoomBy={zoomBy}
            onLink={(l) => void followLink(l)}
          />
        </div>
      </div>
    </div>
  );
}
