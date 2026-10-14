# Get shipment

`GET /v2/shipments/{shipmentId}` returns the current status of a freight shipment.

```yaml
operationId: getShipment
parameters:
  - name: shipmentId
    in: path
    required: true
    schema:
      type: string
responses:
  "200":
    description: The shipment, including `status` (one of `booked`, `in_transit`, `delivered`).
```
