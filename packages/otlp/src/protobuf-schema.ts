import { Root, type Type } from "protobufjs";

// Reflection descriptor for the stable trace messages reviewed from opentelemetry-proto v1.11.0.
// Unknown wire fields remain forward compatible because protobufjs skips fields absent here.
const root = Root.fromJSON({
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Any: {
              fields: {
                typeUrl: { id: 1, type: "string" },
                value: { id: 2, type: "bytes" },
              },
            },
          },
        },
        rpc: {
          nested: {
            Status: {
              fields: {
                code: { id: 1, type: "int32" },
                details: {
                  id: 3,
                  rule: "repeated",
                  type: "google.protobuf.Any",
                },
                message: { id: 2, type: "string" },
              },
            },
          },
        },
      },
    },
    opentelemetry: {
      nested: {
        proto: {
          nested: {
            collector: {
              nested: {
                trace: {
                  nested: {
                    v1: {
                      nested: {
                        ExportTracePartialSuccess: {
                          fields: {
                            errorMessage: { id: 2, type: "string" },
                            rejectedSpans: { id: 1, type: "int64" },
                          },
                        },
                        ExportTraceServiceRequest: {
                          fields: {
                            resourceSpans: {
                              id: 1,
                              rule: "repeated",
                              type: "opentelemetry.proto.trace.v1.ResourceSpans",
                            },
                          },
                        },
                        ExportTraceServiceResponse: {
                          fields: {
                            partialSuccess: {
                              id: 1,
                              type: "opentelemetry.proto.collector.trace.v1.ExportTracePartialSuccess",
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            common: {
              nested: {
                v1: {
                  nested: {
                    AnyValue: {
                      fields: {
                        arrayValue: {
                          id: 5,
                          type: "opentelemetry.proto.common.v1.ArrayValue",
                        },
                        boolValue: { id: 2, type: "bool" },
                        bytesValue: { id: 7, type: "bytes" },
                        doubleValue: { id: 4, type: "double" },
                        intValue: { id: 3, type: "int64" },
                        kvlistValue: {
                          id: 6,
                          type: "opentelemetry.proto.common.v1.KeyValueList",
                        },
                        stringValue: { id: 1, type: "string" },
                      },
                      oneofs: {
                        value: {
                          oneof: [
                            "stringValue",
                            "boolValue",
                            "intValue",
                            "doubleValue",
                            "arrayValue",
                            "kvlistValue",
                            "bytesValue",
                          ],
                        },
                      },
                    },
                    ArrayValue: {
                      fields: {
                        values: {
                          id: 1,
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.AnyValue",
                        },
                      },
                    },
                    InstrumentationScope: {
                      fields: {
                        attributes: {
                          id: 3,
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                        },
                        droppedAttributesCount: { id: 4, type: "uint32" },
                        name: { id: 1, type: "string" },
                        version: { id: 2, type: "string" },
                      },
                    },
                    KeyValue: {
                      fields: {
                        key: { id: 1, type: "string" },
                        value: {
                          id: 2,
                          type: "opentelemetry.proto.common.v1.AnyValue",
                        },
                      },
                    },
                    KeyValueList: {
                      fields: {
                        values: {
                          id: 1,
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                        },
                      },
                    },
                  },
                },
              },
            },
            resource: {
              nested: {
                v1: {
                  nested: {
                    Resource: {
                      fields: {
                        attributes: {
                          id: 1,
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                        },
                        droppedAttributesCount: { id: 2, type: "uint32" },
                      },
                    },
                  },
                },
              },
            },
            trace: {
              nested: {
                v1: {
                  nested: {
                    ResourceSpans: {
                      fields: {
                        resource: {
                          id: 1,
                          type: "opentelemetry.proto.resource.v1.Resource",
                        },
                        schemaUrl: { id: 3, type: "string" },
                        scopeSpans: {
                          id: 2,
                          rule: "repeated",
                          type: "opentelemetry.proto.trace.v1.ScopeSpans",
                        },
                      },
                    },
                    ScopeSpans: {
                      fields: {
                        schemaUrl: { id: 3, type: "string" },
                        scope: {
                          id: 1,
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                        },
                        spans: {
                          id: 2,
                          rule: "repeated",
                          type: "opentelemetry.proto.trace.v1.Span",
                        },
                      },
                    },
                    Span: {
                      fields: {
                        attributes: {
                          id: 9,
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                        },
                        droppedAttributesCount: { id: 10, type: "uint32" },
                        droppedEventsCount: { id: 12, type: "uint32" },
                        droppedLinksCount: { id: 14, type: "uint32" },
                        endTimeUnixNano: { id: 8, type: "fixed64" },
                        events: {
                          id: 11,
                          rule: "repeated",
                          type: "opentelemetry.proto.trace.v1.Span.Event",
                        },
                        flags: { id: 16, type: "fixed32" },
                        kind: { id: 6, type: "opentelemetry.proto.trace.v1.Span.SpanKind" },
                        links: {
                          id: 13,
                          rule: "repeated",
                          type: "opentelemetry.proto.trace.v1.Span.Link",
                        },
                        name: { id: 5, type: "string" },
                        parentSpanId: { id: 4, type: "bytes" },
                        spanId: { id: 2, type: "bytes" },
                        startTimeUnixNano: { id: 7, type: "fixed64" },
                        status: {
                          id: 15,
                          type: "opentelemetry.proto.trace.v1.Status",
                        },
                        traceId: { id: 1, type: "bytes" },
                        traceState: { id: 3, type: "string" },
                      },
                      nested: {
                        Event: {
                          fields: {
                            attributes: {
                              id: 3,
                              rule: "repeated",
                              type: "opentelemetry.proto.common.v1.KeyValue",
                            },
                            droppedAttributesCount: { id: 4, type: "uint32" },
                            name: { id: 2, type: "string" },
                            timeUnixNano: { id: 1, type: "fixed64" },
                          },
                        },
                        Link: {
                          fields: {
                            attributes: {
                              id: 4,
                              rule: "repeated",
                              type: "opentelemetry.proto.common.v1.KeyValue",
                            },
                            droppedAttributesCount: { id: 5, type: "uint32" },
                            flags: { id: 6, type: "fixed32" },
                            spanId: { id: 2, type: "bytes" },
                            traceId: { id: 1, type: "bytes" },
                            traceState: { id: 3, type: "string" },
                          },
                        },
                        SpanKind: {
                          values: {
                            SPAN_KIND_UNSPECIFIED: 0,
                            SPAN_KIND_INTERNAL: 1,
                            SPAN_KIND_SERVER: 2,
                            SPAN_KIND_CLIENT: 3,
                            SPAN_KIND_PRODUCER: 4,
                            SPAN_KIND_CONSUMER: 5,
                          },
                        },
                      },
                    },
                    Status: {
                      fields: {
                        code: {
                          id: 3,
                          type: "opentelemetry.proto.trace.v1.Status.StatusCode",
                        },
                        message: { id: 2, type: "string" },
                      },
                      nested: {
                        StatusCode: {
                          values: {
                            STATUS_CODE_UNSET: 0,
                            STATUS_CODE_OK: 1,
                            STATUS_CODE_ERROR: 2,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

export const exportTraceRequestType = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
export const exportTraceResponseType = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse",
);
export const rpcStatusType = root.lookupType("google.rpc.Status");

export function protobufType(name: "request" | "response" | "status"): Type {
  switch (name) {
    case "request":
      return exportTraceRequestType;
    case "response":
      return exportTraceResponseType;
    case "status":
      return rpcStatusType;
  }
}
