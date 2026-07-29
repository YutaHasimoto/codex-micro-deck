import AVFoundation
import Darwin
import Foundation

private final class LockedValue: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0.0

  func set(_ next: Double) {
    lock.lock()
    value = next
    lock.unlock()
  }

  func get() -> Double {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

private final class LockedAuthorization: @unchecked Sendable {
  private let lock = NSLock()
  private var granted = false

  func set(_ next: Bool) {
    lock.lock()
    granted = next
    lock.unlock()
  }

  func get() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return granted
  }
}

private func writeStandardError(_ message: String) {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
}

private func microphoneIsAuthorized() -> Bool {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized:
    return true
  case .denied, .restricted:
    return false
  case .notDetermined:
    let result = LockedAuthorization()
    let completed = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      result.set(granted)
      completed.signal()
    }
    completed.wait()
    return result.get()
  @unknown default:
    return false
  }
}

guard microphoneIsAuthorized() else {
  writeStandardError("permission-denied")
  exit(2)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0, format.channelCount > 0 else {
  writeStandardError("no-input-device")
  exit(3)
}

private let latestLevel = LockedValue()
input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
  guard let channels = buffer.floatChannelData else {
    latestLevel.set(0)
    return
  }

  let frameCount = Int(buffer.frameLength)
  let channelCount = Int(buffer.format.channelCount)
  guard frameCount > 0, channelCount > 0 else {
    latestLevel.set(0)
    return
  }

  var sumOfSquares = 0.0
  for channelIndex in 0..<channelCount {
    let samples = channels[channelIndex]
    for frameIndex in 0..<frameCount {
      let sample = Double(samples[frameIndex])
      sumOfSquares += sample * sample
    }
  }

  let rms = sqrt(sumOfSquares / Double(frameCount * channelCount))
  let decibels = 20 * log10(max(rms, 0.000_000_01))
  // Map roughly -55 dBFS (quiet room) through -10 dBFS (loud speech) to 0...1.
  latestLevel.set(min(1, max(0, (decibels + 55) / 45)))
}

do {
  engine.prepare()
  try engine.start()
} catch {
  input.removeTap(onBus: 0)
  writeStandardError("engine-start-failed")
  exit(4)
}

let outputTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
outputTimer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(15))
outputTimer.setEventHandler {
  let line = String(format: "%.4f\n", latestLevel.get())
  FileHandle.standardOutput.write(Data(line.utf8))
}
outputTimer.resume()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let terminationQueue = DispatchQueue(label: "works.kawaii.codex-shortcuts-plugin.mic-level-meter.termination")
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: terminationQueue)
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: terminationQueue)
let stop: @Sendable () -> Void = {
  outputTimer.cancel()
  input.removeTap(onBus: 0)
  engine.stop()
  exit(0)
}
terminate.setEventHandler(handler: stop)
interrupt.setEventHandler(handler: stop)
terminate.resume()
interrupt.resume()

dispatchMain()
