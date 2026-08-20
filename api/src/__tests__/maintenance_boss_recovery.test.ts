import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Recuperación de los jobs de mantenimiento.
 *
 * El fallo que motiva estos tests: si `boss.start()` no conectaba, la promesa
 * quedaba **rechazada y memoizada**, así que ningún intento posterior podía
 * prosperar. La API seguía sirviendo HTTP con la expiración de pedidos, la
 * recurrencia y los webhooks muertos, y sin nada en los logs.
 *
 * Se prueba contra el módulo real con pg-boss mockeado, porque lo que hay que
 * fijar es justamente su lógica de arranque y reintento.
 */

const startMock = vi.fn();
const onMock = vi.fn();

vi.mock('pg-boss', () => ({
  PgBoss: class {
    start = startMock;
    on = onMock;
    createQueue = vi.fn().mockResolvedValue(undefined);
    work = vi.fn().mockResolvedValue(undefined);
    schedule = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

// `initMaintenanceJobs` no hace nada con NODE_ENV=test, que es justo lo que se
// quiere ejercitar. Se fuerza otro entorno solo para estas pruebas.
const ORIGINAL_ENV = process.env.NODE_ENV;

async function loadModule() {
  vi.resetModules();
  process.env.NODE_ENV = 'development';
  return import('../jobs/maintenance_boss.js');
}

describe('initMaintenanceJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  it('arranca y queda en running', async () => {
    startMock.mockResolvedValue(undefined);
    const mod = await loadModule();

    await mod.initMaintenanceJobs();

    expect(mod.getMaintenanceJobsStatus().state).toBe('running');
    expect(mod.getMaintenanceBoss()).not.toBeNull();
  });

  it('escucha los errores de pg-boss: sin oyente son excepciones no capturadas', async () => {
    startMock.mockResolvedValue(undefined);
    const mod = await loadModule();

    await mod.initMaintenanceJobs();

    expect(onMock).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('un fallo de arranque deja estado failed y no una instancia a medias', async () => {
    startMock.mockRejectedValue(new Error('too many connections'));
    const mod = await loadModule();

    await expect(mod.initMaintenanceJobs()).rejects.toThrow('too many connections');

    const status = mod.getMaintenanceJobsStatus();
    expect(status.state).toBe('failed');
    expect(status.lastError).toContain('too many connections');
    expect(status.failedAttempts).toBe(1);
    expect(mod.getMaintenanceBoss()).toBeNull();
  });

  it('**el fallo no es definitivo**: un intento posterior vuelve a probar', async () => {
    startMock.mockRejectedValueOnce(new Error('too many connections'));
    const mod = await loadModule();

    await expect(mod.initMaintenanceJobs()).rejects.toThrow();

    // Antes esto devolvía la misma promesa rechazada para siempre.
    startMock.mockResolvedValue(undefined);
    await mod.initMaintenanceJobs();

    expect(mod.getMaintenanceJobsStatus().state).toBe('running');
    expect(mod.getMaintenanceJobsStatus().failedAttempts).toBe(0);
  });

  it('reintenta solo con el tiempo, sin que nadie lo llame', async () => {
    startMock.mockRejectedValueOnce(new Error('db caída'));
    const mod = await loadModule();

    await expect(mod.initMaintenanceJobs()).rejects.toThrow();
    expect(startMock).toHaveBeenCalledTimes(1);

    // La BD vuelve y el temporizador de reintento se dispara.
    startMock.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(startMock).toHaveBeenCalledTimes(2);
    expect(mod.getMaintenanceJobsStatus().state).toBe('running');
  });

  it('no arranca dos veces si se le llama en paralelo', async () => {
    startMock.mockResolvedValue(undefined);
    const mod = await loadModule();

    await Promise.all([mod.initMaintenanceJobs(), mod.initMaintenanceJobs()]);

    expect(startMock).toHaveBeenCalledTimes(1);
  });
});
